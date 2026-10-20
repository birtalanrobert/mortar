import { openSecret, resolveManager, runInTransaction, sealSecret } from '@birtalanrobert/database';
import type { DataSource, EntityManager } from 'typeorm';
import { SecondFactor, type BaseSecondFactor } from '../entities/second-factor';
import {
  SecondFactorEnrolledError,
  SecondFactorInvalidError,
  SecondFactorLockedError,
  SecondFactorNotEnrolledError,
} from '../errors';
import {
  RECOVERY_CODE_COUNT,
  generateRecoveryCodes,
  hashRecoveryCode,
  looksLikeRecoveryCode,
} from '../recovery-codes';
import { base32Decode, generateTotpSecret, matchTotpStep, otpauthUri } from '../totp';

export interface SecondFactorOptions {
  /**
   * The 32 bytes every secret is sealed with — `sealingKey()` of what the
   * deployment holds. Lose it and every second factor must be set up again.
   */
  secretKey: Buffer;
  /** The name an authenticator app shows beside the code: the product's. */
  issuer: string;
  /** Time steps either side of now a code may be for — a phone's clock a little off. Default 1. */
  window?: number;
  /** Wrong codes before the lock. Default 5. */
  maxFailures?: number;
  /** How long the lock lasts. Default 15 minutes. */
  lockMs?: number;
  /** Recovery codes an enrolment is given. Default 10. */
  recoveryCodes?: number;
  /** Override when the project extends `BaseSecondFactor`. */
  entity?: new () => BaseSecondFactor;
}

/** What checking a code came to: what a right one earned, or how many wrong ones there are now. */
type Outcome<T> =
  { readonly accepted: T } | { readonly failures: number; readonly lockedUntil: Date | null };

/** Where an account's second factor stands. */
export interface SecondFactorStatus {
  readonly confirmed: boolean;
  readonly recoveryCodesLeft: number;
  readonly lockedUntil: Date | null;
}

/** An enrolment begun: what the authenticator app is given. */
export interface SecondFactorEnrolment {
  /** The base32 secret, for typing into the app by hand. */
  readonly secret: string;
  /** The `otpauth://` link, for a QR code or a tap on a phone. */
  readonly uri: string;
}

/** A code accepted: which kind, and how many recovery codes are left. */
export interface SecondFactorCheck {
  readonly method: 'totp' | 'recovery';
  readonly recoveryCodesLeft: number;
}

/**
 * A second factor for signing in: a code from an authenticator app (RFC 6238),
 * or one of the recovery codes for when the phone is gone.
 *
 * **A code is good once.** The time step of the last code accepted is kept,
 * and none at or before it passes again — a code seen over somebody's
 * shoulder, or replayed from a log, is spent. The row is locked while a code is
 * checked, so two requests with the same code cannot both pass.
 *
 * **Wrong codes lock it.** After `maxFailures` wrong codes in a row, no code
 * is checked until the lock ends; a right one clears the count. Six digits
 * against five tries in fifteen minutes is a guess nobody wins.
 *
 * The product decides when a second factor is asked for and who must have
 * one; this keeps the secret, checks the codes and says why one failed.
 *
 * **Check a code outside a transaction of the caller's.** A wrong code is
 * counted in a transaction of its own and the error thrown once it commits;
 * inside the caller's, which the error then rolls back, the count would go
 * with it — and the lock would never come.
 */
export class SecondFactorService {
  private readonly entity: new () => BaseSecondFactor;
  private readonly window: number;
  private readonly maxFailures: number;
  private readonly lockMs: number;
  private readonly recoveryCount: number;

  constructor(
    private readonly dataSource: DataSource,
    private readonly options: SecondFactorOptions,
  ) {
    if (options.secretKey.length !== 32) {
      throw new Error('A second factor sealing key must be 32 bytes.');
    }
    this.entity = options.entity ?? SecondFactor;
    this.window = options.window ?? 1;
    this.maxFailures = options.maxFailures ?? 5;
    this.lockMs = options.lockMs ?? 15 * 60_000;
    this.recoveryCount = options.recoveryCodes ?? RECOVERY_CODE_COUNT;
  }

  private manager(explicit?: EntityManager): EntityManager {
    return explicit ?? resolveManager(this.dataSource);
  }

  /** Where the account's second factor stands, or null for none begun. */
  async status(userId: string, manager?: EntityManager): Promise<SecondFactorStatus | null> {
    const row = await this.manager(manager).findOne(this.entity, { where: { userId } });
    if (!row) return null;
    return {
      confirmed: row.confirmedAt !== null,
      recoveryCodesLeft: row.recoveryCodeHashes.length,
      lockedUntil: row.lockedUntil,
    };
  }

  /**
   * An enrolment begun, or the one already begun: the same secret until a code
   * confirms it, so a page reloaded half-way shows what the app already holds.
   * `account` is what the app labels it with — an address, a name.
   */
  async begin(userId: string, account: string): Promise<SecondFactorEnrolment> {
    return runInTransaction(this.dataSource, async () => {
      const em = this.manager();
      const existing = await em.findOne(this.entity, {
        where: { userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (existing?.confirmedAt) throw new SecondFactorEnrolledError();

      if (!existing) {
        // Ignored if another request inserted one first: its secret is the one shown.
        await em
          .createQueryBuilder()
          .insert()
          .into(this.entity)
          .values({
            userId,
            secretSealed: sealSecret(generateTotpSecret(), this.options.secretKey),
          })
          .orIgnore()
          .execute();
      }
      const row = existing ?? (await em.findOneOrFail(this.entity, { where: { userId } }));
      if (row.confirmedAt) throw new SecondFactorEnrolledError();
      const secret = openSecret(row.secretSealed, this.options.secretKey);
      return { secret, uri: otpauthUri({ issuer: this.options.issuer, account, secret }) };
    });
  }

  /**
   * The enrolment confirmed by a first code from the app — proof that it holds
   * the secret — and its recovery codes made: answered with them, to be shown
   * once and never again.
   */
  async confirm(userId: string, code: string, now = new Date()): Promise<string[]> {
    return this.checked(userId, now, async (row, em) => {
      if (row.confirmedAt) throw new SecondFactorEnrolledError();
      const step = this.stepOf(row, code, now);
      if (step === null) return null;

      const codes = generateRecoveryCodes(this.recoveryCount);
      await em.update(
        this.entity,
        { userId },
        {
          confirmedAt: now,
          lastStep: step,
          recoveryCodeHashes: codes.map(hashRecoveryCode),
          failedAttempts: 0,
          lockedUntil: null,
        },
      );
      return codes;
    });
  }

  /**
   * A code checked: the app's, good once, or a recovery code, used up. Throws
   * `SecondFactorInvalidError` for a wrong one, `SecondFactorLockedError`
   * while locked, and `SecondFactorNotEnrolledError` with none confirmed.
   */
  async verify(userId: string, code: string, now = new Date()): Promise<SecondFactorCheck> {
    return this.checked(userId, now, async (row, em) => {
      if (!row.confirmedAt) throw new SecondFactorNotEnrolledError();

      if (looksLikeRecoveryCode(code)) {
        const hash = hashRecoveryCode(code);
        if (!row.recoveryCodeHashes.includes(hash)) return null;
        const left = row.recoveryCodeHashes.filter((kept) => kept !== hash);
        await em.update(
          this.entity,
          { userId },
          { recoveryCodeHashes: left, failedAttempts: 0, lockedUntil: null },
        );
        return { method: 'recovery' as const, recoveryCodesLeft: left.length };
      }

      const step = this.stepOf(row, code, now);
      if (step === null) return null;
      await em.update(
        this.entity,
        { userId },
        { lastStep: step, failedAttempts: 0, lockedUntil: null },
      );
      return { method: 'totp' as const, recoveryCodesLeft: row.recoveryCodeHashes.length };
    });
  }

  /**
   * New recovery codes, the old ones gone — asked with a code from the app,
   * never a recovery code, since whoever asks must hold the phone. Answered
   * with the new codes, shown once.
   */
  async renewRecoveryCodes(userId: string, code: string, now = new Date()): Promise<string[]> {
    return this.checked(userId, now, async (row, em) => {
      if (!row.confirmedAt) throw new SecondFactorNotEnrolledError();
      const step = this.stepOf(row, code, now);
      if (step === null) return null;

      const codes = generateRecoveryCodes(this.recoveryCount);
      await em.update(
        this.entity,
        { userId },
        {
          lastStep: step,
          recoveryCodeHashes: codes.map(hashRecoveryCode),
          failedAttempts: 0,
          lockedUntil: null,
        },
      );
      return codes;
    });
  }

  /** The account's second factor gone — to be set up again, a lost phone's or a departing person's. */
  async remove(userId: string, manager?: EntityManager): Promise<void> {
    await this.manager(manager).delete(this.entity, { userId });
  }

  /** The time step a fresh code of the app's matches, or null for one wrong or used. */
  private stepOf(row: BaseSecondFactor, code: string, now: Date): number | null {
    const secret = base32Decode(openSecret(row.secretSealed, this.options.secretKey));
    const step = matchTotpStep(secret, code, now.getTime(), { window: this.window });
    if (step === null || (row.lastStep !== null && step <= row.lastStep)) return null;
    return step;
  }

  /**
   * A code checked against the account's row, held for the transaction: locked
   * out while the lock lasts; `accept` answering what a right code earns, or
   * null for a wrong one, which is counted — and, at the limit, locks it.
   */
  private async checked<T>(
    userId: string,
    now: Date,
    accept: (row: BaseSecondFactor, em: EntityManager) => Promise<T | null>,
  ): Promise<T> {
    const outcome = await runInTransaction(this.dataSource, async (): Promise<Outcome<T>> => {
      const em = this.manager();
      const row = await em.findOne(this.entity, {
        where: { userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!row) throw new SecondFactorNotEnrolledError();
      if (row.lockedUntil && row.lockedUntil.getTime() > now.getTime()) {
        throw new SecondFactorLockedError(row.lockedUntil);
      }

      const accepted = await accept(row, em);
      if (accepted !== null) return { accepted };

      const failures = row.failedAttempts + 1;
      const lockedUntil =
        failures >= this.maxFailures ? new Date(now.getTime() + this.lockMs) : null;
      await em.update(
        this.entity,
        { userId },
        { failedAttempts: lockedUntil ? 0 : failures, lockedUntil },
      );
      return { failures, lockedUntil };
    });

    if ('accepted' in outcome) return outcome.accepted;
    // Thrown after the count commits: an error inside the transaction would roll it back.
    if (outcome.lockedUntil) throw new SecondFactorLockedError(outcome.lockedUntil);
    throw new SecondFactorInvalidError(this.maxFailures - outcome.failures);
  }
}
