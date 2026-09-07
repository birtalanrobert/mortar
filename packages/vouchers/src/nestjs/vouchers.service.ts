import { randomInt } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { In } from 'typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { InjectDataSource } from '@birtalanrobert/database';
import { runInTenantTransaction } from '@birtalanrobert/tenancy';
import { ConflictError, NotFoundError, ValidationError } from '@birtalanrobert/http';
import {
  CODE_GROUPS,
  CODE_GROUP_LENGTH,
  balanceOf,
  canRedeem,
  codeAlphabet,
  expiryFrom,
  looksLikeCode,
  normaliseCode,
  type Denomination,
  type EntryKind,
  type Refusal,
} from '../index';
import { VoucherEntity, VoucherEntryEntity } from './voucher.entity';

export interface IssueRequest {
  readonly denomination: Denomination;
  /** Minor units for money, a count for units. Always positive. */
  readonly amount: number;
  /** Required for money and refused for units: a session has no currency. */
  readonly currency?: string;
  /** What a package is for. Absent makes it a gift voucher. */
  readonly subject?: string;
  /** Months from now. Absent or null means it does not expire. */
  readonly expiresAfterMonths?: number | null;
  readonly holderId?: string;
  readonly holderName?: string;
  readonly boughtByName?: string;
  readonly note?: string;
  /** Supplied only when a business prints its own cards. */
  readonly code?: string;
}

export interface VoucherView {
  readonly id: string;
  readonly code: string;
  readonly denomination: Denomination;
  readonly currency: string | null;
  readonly subject: string | null;
  readonly issuedAmount: number;
  readonly balance: number;
  readonly expiresAt: string | null;
  readonly cancelledAt: string | null;
  readonly cancelledReason: string | null;
  readonly holderId: string | null;
  readonly holderName: string | null;
  readonly boughtByName: string | null;
}

export interface VoucherEntryView {
  readonly id: string;
  readonly kind: EntryKind;
  readonly amount: number;
  readonly subject: string | null;
  readonly note: string | null;
  readonly at: string;
}

/**
 * Issuing, redeeming and explaining stored value.
 *
 * **Every change is an entry, and the balance is their sum.** The `balance`
 * column is a cache written in the same transaction, and the database's
 * `CHECK (balance >= 0)` is what makes overspending impossible even when the
 * application is wrong. That arrangement is deliberate and is the same one the
 * catalogue uses for class capacity: a lock in front so the ordinary case is a
 * polite refusal, a constraint behind so the guarantee does not depend on it.
 */
@Injectable()
export class VouchersService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Sells one.
   *
   * The code is generated here rather than by the caller, and retried on the
   * one-in-a-hundred-million collision rather than assumed away — a unique
   * index that can fail is one that eventually does, and the failure would land
   * on a customer at a counter.
   */
  async issue(tenantId: string, request: IssueRequest, now = new Date()): Promise<VoucherView> {
    if (!Number.isFinite(request.amount) || request.amount <= 0) {
      throw new ValidationError(
        [{ field: 'amount', message: 'A voucher is worth something.' }],
        'A voucher is worth something.',
      );
    }

    if (request.denomination === 'units' && !Number.isInteger(request.amount)) {
      throw new ValidationError(
        [{ field: 'amount', message: 'A package is a whole number of sessions.' }],
        'A package is a whole number of sessions.',
      );
    }

    if (request.denomination === 'money' && !request.currency) {
      throw new ValidationError(
        [{ field: 'currency', message: 'A voucher for money needs a currency.' }],
        'A voucher for money needs a currency.',
      );
    }

    const expiresAt = expiryFrom(now.getTime(), request.expiresAfterMonths ?? null);

    return runInTenantTransaction(
      this.dataSource,
      async (scoped) => {
        const vouchers = scoped.getRepository(VoucherEntity);
        const amount = String(Math.round(request.amount));

        for (let attempt = 0; attempt < 5; attempt += 1) {
          const code = request.code ? normaliseCode(request.code) : this.freshCode();

          if (!looksLikeCode(code)) {
            throw new ValidationError(
              [{ field: 'code', message: 'That is not a voucher code.' }],
              'That is not a voucher code.',
            );
          }

          const taken = await vouchers.findOne({ where: { tenantId, code } });

          if (taken) {
            // A code the business supplied and already used is a mistake worth
            // naming; one we generated is a collision worth retrying past.
            if (request.code) throw new ConflictError('That code is already in use.');
            continue;
          }

          const voucher = await vouchers.save(
            vouchers.create({
              tenantId,
              code,
              denomination: request.denomination,
              currency: request.denomination === 'money' ? (request.currency ?? null) : null,
              subject: request.subject ?? null,
              issuedAmount: amount,
              balance: amount,
              expiresAt: expiresAt === null ? null : new Date(expiresAt),
              holderId: request.holderId ?? null,
              holderName: request.holderName ?? null,
              boughtByName: request.boughtByName ?? null,
              note: request.note ?? null,
            }),
          );

          await this.write(scoped, tenantId, voucher.id, {
            kind: 'issued',
            amount: request.amount,
            ...(request.note ? { note: request.note } : {}),
          });

          return toView(voucher);
        }

        /*
         * Five collisions in a row against 32^12 is not chance. Something is
         * wrong with the generator, and saying so is better than looping.
         */
        throw new ConflictError('Could not allocate a voucher code. Try again.');
      },
      { tenantId },
    );
  }

  /** One voucher, by the code somebody typed. */
  async byCode(tenantId: string, typed: string): Promise<VoucherView> {
    const code = normaliseCode(typed);

    if (!looksLikeCode(code)) throw new NotFoundError('Voucher', typed);

    const voucher = await runInTenantTransaction(
      this.dataSource,
      (scoped) => scoped.getRepository(VoucherEntity).findOne({ where: { tenantId, code } }),
      { tenantId },
    );

    if (!voucher) throw new NotFoundError('Voucher', code);

    return toView(voucher);
  }

  async byId(tenantId: string, id: string): Promise<VoucherView> {
    const voucher = await runInTenantTransaction(
      this.dataSource,
      (scoped) => scoped.getRepository(VoucherEntity).findOne({ where: { tenantId, id } }),
      { tenantId },
    );

    if (!voucher) throw new NotFoundError('Voucher', id);

    return toView(voucher);
  }

  /** Everything a customer holds, newest first. */
  async forHolder(tenantId: string, holderId: string): Promise<VoucherView[]> {
    return runInTenantTransaction(
      this.dataSource,
      async (scoped) => {
        const rows = await scoped.getRepository(VoucherEntity).find({
          where: { tenantId, holderId },
          order: { createdAt: 'DESC' },
        });

        return rows.map(toView);
      },
      { tenantId },
    );
  }

  /**
   * What happened to it, in order.
   *
   * The half of "a ledger rather than a counter" that a customer sees: six
   * sessions used, and here is which appointment each went against.
   */
  async history(tenantId: string, voucherId: string): Promise<VoucherEntryView[]> {
    return runInTenantTransaction(
      this.dataSource,
      async (scoped) => {
        const rows = await scoped.getRepository(VoucherEntryEntity).find({
          where: { tenantId, voucherId },
          order: { createdAt: 'ASC' },
        });

        return rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          amount: Number(row.amount),
          subject: row.subject,
          note: row.note,
          at: row.createdAt.toISOString(),
        }));
      },
      { tenantId },
    );
  }

  /**
   * Spends some of it.
   *
   * The voucher row is locked for update and the decision is taken inside the
   * lock, so two tills reaching for the last session produce one redemption and
   * one polite refusal rather than a balance of minus one.
   */
  async redeem(
    tenantId: string,
    input: {
      readonly voucherId: string;
      readonly amount: number;
      readonly subject: string;
      readonly serviceSubject?: string;
      readonly actorId?: string;
      readonly note?: string;
    },
    now = new Date(),
  ): Promise<VoucherView> {
    return runInTenantTransaction(
      this.dataSource,
      async (scoped) => {
        const voucher = await this.locked(scoped, tenantId, input.voucherId);

        const decision = canRedeem(
          {
            denomination: voucher.denomination,
            balance: Number(voucher.balance),
            expiresAt: voucher.expiresAt?.getTime() ?? null,
            cancelledAt: voucher.cancelledAt?.getTime() ?? null,
            serviceId: voucher.subject,
          },
          {
            amount: input.amount,
            ...(input.serviceSubject === undefined ? {} : { serviceId: input.serviceSubject }),
          },
          now.getTime(),
        );

        if (!decision.ok) throw refusalOf(decision.why, Number(voucher.balance));

        await this.apply(scoped, tenantId, voucher, {
          kind: 'redeemed',
          amount: input.amount,
          subject: input.subject,
          ...(input.actorId ? { actorId: input.actorId } : {}),
          ...(input.note ? { note: input.note } : {}),
        });

        return this.byId(tenantId, voucher.id);
      },
      { tenantId },
    );
  }

  /**
   * Gives a redemption back.
   *
   * An appointment cancelled, or a mistake at the desk. Never more than was
   * taken against that subject: a release larger than its redemption is either
   * a typo or a way to print money, and neither should be possible.
   */
  async release(
    tenantId: string,
    input: {
      readonly voucherId: string;
      readonly subject: string;
      readonly actorId?: string;
      readonly note?: string;
    },
  ): Promise<VoucherView> {
    return runInTenantTransaction(
      this.dataSource,
      async (scoped) => {
        const voucher = await this.locked(scoped, tenantId, input.voucherId);

        const against = await scoped.getRepository(VoucherEntryEntity).find({
          where: { tenantId, voucherId: voucher.id, subject: input.subject },
        });

        const outstanding = balanceOf(
          against.map((row) => ({ kind: row.kind, amount: Number(row.amount) })),
        );

        /*
         * `balanceOf` over just this subject's entries: redemptions count
         * negative and releases positive, so what is left is what has been
         * taken and not yet given back. Zero means there is nothing to release,
         * which includes the case of releasing twice.
         */
        if (outstanding >= 0) {
          throw new ConflictError('Nothing was taken from that voucher for this.');
        }

        await this.apply(scoped, tenantId, voucher, {
          kind: 'released',
          amount: Math.abs(outstanding),
          subject: input.subject,
          ...(input.actorId ? { actorId: input.actorId } : {}),
          ...(input.note ? { note: input.note } : {}),
        });

        return this.byId(tenantId, voucher.id);
      },
      { tenantId },
    );
  }

  /**
   * Writes value on or off by hand.
   *
   * A gesture of goodwill, or a correction. It is a *named* entry rather than
   * an edit to the balance, so a business can always answer where the number
   * came from — and `expired` is a separate kind rather than a negative
   * adjustment, because "we wrote this off" and "this ran out" are different
   * facts and only one of them is the customer's fault.
   */
  async adjust(
    tenantId: string,
    input: {
      readonly voucherId: string;
      readonly amount: number;
      readonly note: string;
      readonly actorId?: string;
    },
  ): Promise<VoucherView> {
    return runInTenantTransaction(
      this.dataSource,
      async (scoped) => {
        const voucher = await this.locked(scoped, tenantId, input.voucherId);

        await this.apply(scoped, tenantId, voucher, {
          kind: 'adjusted',
          amount: input.amount,
          note: input.note,
          ...(input.actorId ? { actorId: input.actorId } : {}),
        });

        return this.byId(tenantId, voucher.id);
      },
      { tenantId },
    );
  }

  /**
   * Stops one, keeping every entry.
   *
   * Cancelled rather than deleted: the sale happened, the business was paid,
   * and the rows are the evidence of both. What a cancellation does is refuse
   * further redemptions.
   */
  async cancel(tenantId: string, voucherId: string, reason: string): Promise<VoucherView> {
    return runInTenantTransaction(
      this.dataSource,
      async (scoped) => {
        const voucher = await this.locked(scoped, tenantId, voucherId);

        if (voucher.cancelledAt) return toView(voucher);

        await scoped
          .getRepository(VoucherEntity)
          .update(
            { tenantId, id: voucher.id },
            { cancelledAt: new Date(), cancelledReason: reason },
          );

        return this.byId(tenantId, voucher.id);
      },
      { tenantId },
    );
  }

  /**
   * Writes off what has run out, and says how much.
   *
   * Swept rather than computed on read, because an expired balance is money the
   * business may now recognise — and a number that only exists while somebody
   * is looking at it cannot be reported on. Each write-off is an `expired`
   * entry, so the history still explains the zero.
   */
  async expire(tenantId: string, now = new Date()): Promise<number> {
    return runInTenantTransaction(
      this.dataSource,
      async (scoped) => {
        const due = await scoped
          .getRepository(VoucherEntity)
          .createQueryBuilder('voucher')
          .where('voucher.tenant_id = :tenantId', { tenantId })
          .andWhere('voucher.expires_at IS NOT NULL')
          .andWhere('voucher.expires_at <= :now', { now })
          .andWhere('voucher.balance > 0')
          .andWhere('voucher.cancelled_at IS NULL')
          .getMany();

        for (const voucher of due) {
          await this.apply(scoped, tenantId, voucher, {
            kind: 'expired',
            amount: Number(voucher.balance),
            note: 'Expired',
          });
        }

        return due.length;
      },
      { tenantId },
    );
  }

  /**
   * Whether the ledger and the cached balance still agree.
   *
   * Exposed rather than kept for tests: a denormalised number is a number that
   * can drift, and a business that suspects one should be able to have it
   * checked rather than argued with.
   */
  async reconcile(
    tenantId: string,
    voucherId: string,
  ): Promise<{ balance: number; ledger: number }> {
    return runInTenantTransaction(
      this.dataSource,
      async (scoped) => {
        const voucher = await scoped
          .getRepository(VoucherEntity)
          .findOne({ where: { tenantId, id: voucherId } });

        if (!voucher) throw new NotFoundError('Voucher', voucherId);

        const entries = await scoped
          .getRepository(VoucherEntryEntity)
          .find({ where: { tenantId, voucherId } });

        return {
          balance: Number(voucher.balance),
          ledger: balanceOf(entries.map((row) => ({ kind: row.kind, amount: Number(row.amount) }))),
        };
      },
      { tenantId },
    );
  }

  /** Several vouchers at once, for a screen that lists them. */
  async byIds(tenantId: string, ids: readonly string[]): Promise<VoucherView[]> {
    if (ids.length === 0) return [];

    return runInTenantTransaction(
      this.dataSource,
      async (scoped) => {
        const rows = await scoped
          .getRepository(VoucherEntity)
          .find({ where: { tenantId, id: In([...ids]) } });

        return rows.map(toView);
      },
      { tenantId },
    );
  }

  /** The row, locked, so two tills cannot decide at the same time. */
  private async locked(
    scoped: EntityManager,
    tenantId: string,
    voucherId: string,
  ): Promise<VoucherEntity> {
    const [voucher] = await scoped
      .getRepository(VoucherEntity)
      .createQueryBuilder('voucher')
      .setLock('pessimistic_write')
      .where('voucher.tenant_id = :tenantId AND voucher.id = :id', { tenantId, id: voucherId })
      .getMany();

    if (!voucher) throw new NotFoundError('Voucher', voucherId);

    return voucher;
  }

  /** One entry, and the cached balance it moves — in one transaction, always. */
  private async apply(
    scoped: EntityManager,
    tenantId: string,
    voucher: VoucherEntity,
    entry: {
      readonly kind: EntryKind;
      readonly amount: number;
      readonly subject?: string;
      readonly note?: string;
      readonly actorId?: string;
    },
  ): Promise<void> {
    await this.write(scoped, tenantId, voucher.id, entry);

    const entries = await scoped
      .getRepository(VoucherEntryEntity)
      .find({ where: { tenantId, voucherId: voucher.id } });

    /*
     * Recomputed from the ledger rather than added to the cache.
     *
     * The ledger is the truth, so the cache is *set* to it — a cache that is
     * incremented drifts the first time an entry is written by anything else,
     * and the drift is invisible until somebody counts.
     */
    const balance = balanceOf(
      entries.map((row) => ({ kind: row.kind, amount: Number(row.amount) })),
    );

    await scoped
      .getRepository(VoucherEntity)
      .update({ tenantId, id: voucher.id }, { balance: String(balance) });
  }

  private async write(
    scoped: EntityManager,
    tenantId: string,
    voucherId: string,
    entry: {
      readonly kind: EntryKind;
      readonly amount: number;
      readonly subject?: string;
      readonly note?: string;
      readonly actorId?: string;
    },
  ): Promise<void> {
    const entries = scoped.getRepository(VoucherEntryEntity);

    await entries.save(
      entries.create({
        tenantId,
        voucherId,
        kind: entry.kind,
        amount: String(Math.round(Math.abs(entry.amount))),
        subject: entry.subject ?? null,
        note: entry.note ?? null,
        actorId: entry.actorId ?? null,
      }),
    );
  }

  /**
   * A code, from a cryptographic source.
   *
   * Server-side only, which is why it is here rather than in the pure root: a
   * console counts a balance in a browser and has no business carrying a
   * generator, and `node:crypto` in the root entry point would put one in every
   * bundle that imports it.
   */
  private freshCode(): string {
    const alphabet = codeAlphabet();
    const groups: string[] = [];

    for (let group = 0; group < CODE_GROUPS; group += 1) {
      let text = '';

      for (let index = 0; index < CODE_GROUP_LENGTH; index += 1) {
        text += alphabet[randomInt(alphabet.length)];
      }

      groups.push(text);
    }

    return groups.join('-');
  }
}

function toView(voucher: VoucherEntity): VoucherView {
  return {
    id: voucher.id,
    code: voucher.code,
    denomination: voucher.denomination,
    currency: voucher.currency,
    subject: voucher.subject,
    issuedAmount: Number(voucher.issuedAmount),
    balance: Number(voucher.balance),
    expiresAt: voucher.expiresAt?.toISOString() ?? null,
    cancelledAt: voucher.cancelledAt?.toISOString() ?? null,
    cancelledReason: voucher.cancelledReason,
    holderId: voucher.holderId,
    holderName: voucher.holderName,
    boughtByName: voucher.boughtByName,
  };
}

/**
 * The sentence somebody at a counter reads out.
 *
 * Each refusal sends the conversation somewhere different — an expired voucher
 * is a conversation with the owner, a package spent on the wrong service is a
 * conversation about which service — so they are separate messages rather than
 * one apology.
 */
function refusalOf(why: Refusal, balance: number): Error {
  switch (why) {
    case 'cancelled':
      return new ConflictError('That voucher has been cancelled.');
    case 'expired':
      return new ConflictError('That voucher has expired.');
    case 'wrong-service':
      return new ConflictError('That package is for a different service.');
    case 'not-enough':
      return new ConflictError(
        balance <= 0 ? 'That voucher has nothing left.' : 'That voucher does not cover it.',
      );
    default:
      return new ValidationError(
        [{ field: 'amount', message: 'How much?' }],
        'How much of the voucher?',
      );
  }
}
