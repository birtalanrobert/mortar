import { getContext } from '@mortar/context';
import { resolveManager, runInTransaction } from '@mortar/database';
import { IsNull, LessThan, type DataSource, type EntityManager } from 'typeorm';
import type { BaseAuthToken, AuthTokenType } from '../entities/auth-token';
import { resolveRegistry, type AuthEntityRegistry } from '../registry';
import { InvalidTokenError } from '../errors';
import { normaliseEmail } from '../email';
import { hashToken, issueToken } from '../tokens';

/** Default lifetimes, chosen per purpose rather than one blanket value. */
export const DEFAULT_TTL: Record<AuthTokenType, number> = {
  // Long enough to survive an email sitting unread overnight.
  email_verification: 24 * 60 * 60 * 1000,
  // Short: it grants account takeover, so its window should be small.
  password_reset: 60 * 60 * 1000,
  // Long: an invitation may wait for someone to come back from leave.
  invitation: 14 * 24 * 60 * 60 * 1000,
  // Very short: it is a password substitute arriving over an insecure channel.
  magic_link: 15 * 60 * 1000,
};

export interface IssueTokenInput {
  type: AuthTokenType;
  email: string;
  userId?: string | null;
  tenantId?: string | null;
  payload?: Record<string, unknown>;
  ttlMs?: number;
  /**
   * Invalidate any outstanding token of the same type for this address.
   *
   * Default true. Two live password-reset links for one account means the
   * older one still works after the user requested a fresh one — which is
   * exactly the situation where they requested a fresh one because they feared
   * the first had been seen.
   */
  replaceExisting?: boolean;
}

export interface IssuedAuthToken {
  /** Put in the link. Never stored. */
  readonly token: string;
  readonly record: BaseAuthToken;
}

export interface TokenServiceOptions {
  /** Override when the project registers its own entity subclasses. */
  entities?: Partial<AuthEntityRegistry>;
}

export class TokenService {
  private readonly entities: AuthEntityRegistry;

  constructor(
    private readonly dataSource: DataSource,
    options: TokenServiceOptions = {},
  ) {
    this.entities = resolveRegistry(options.entities);
  }

  private manager(explicit?: EntityManager): EntityManager {
    return explicit ?? resolveManager(this.dataSource);
  }

  async issue(input: IssueTokenInput, manager?: EntityManager): Promise<IssuedAuthToken> {
    const em = this.manager(manager);
    const email = normaliseEmail(input.email);

    if (input.replaceExisting !== false) {
      await em.update(
        this.entities.authToken,
        { type: input.type, email, consumedAt: IsNull() },
        { consumedAt: new Date() },
      );
    }

    const { token, hash } = issueToken();
    const record = em.create(this.entities.authToken, {
      type: input.type,
      tokenHash: hash,
      email,
      userId: input.userId ?? null,
      tenantId: input.tenantId ?? null,
      payload: input.payload ?? null,
      expiresAt: new Date(Date.now() + (input.ttlMs ?? DEFAULT_TTL[input.type])),
      consumedAt: null,
      createdBy: getContext()?.actor?.id ?? null,
    });

    return { token, record: await em.save(this.entities.authToken, record) };
  }

  /**
   * Reads a token without spending it, for a "is this link still valid" check
   * before showing a form. Never authorises anything on its own.
   */
  async peek(
    token: string,
    type: AuthTokenType,
    manager?: EntityManager,
  ): Promise<BaseAuthToken | null> {
    const record = await this.manager(manager).findOne(this.entities.authToken, {
      where: { tokenHash: hashToken(token), type },
    });
    if (!record || record.consumedAt || record.expiresAt <= new Date()) return null;
    return record;
  }

  /**
   * Spends a token, atomically.
   *
   * The consume is a conditional UPDATE rather than a read-then-write: two
   * requests arriving together — a double-clicked link, an email client
   * pre-fetching the URL — would otherwise both read it as unspent and both
   * proceed. The database decides which one wins.
   */
  async consume(
    token: string,
    type: AuthTokenType,
    manager?: EntityManager,
  ): Promise<BaseAuthToken> {
    const em = this.manager(manager);
    const now = new Date();

    const result = await em
      .createQueryBuilder()
      .update(this.entities.authToken)
      .set({ consumedAt: now })
      .where('token_hash = :hash', { hash: hashToken(token) })
      .andWhere('type = :type', { type })
      .andWhere('consumed_at IS NULL')
      .andWhere('expires_at > :now', { now })
      .returning('id')
      .execute();

    const id = (result.raw as Array<{ id: string }>)[0]?.id;
    // Unknown, expired and already-spent are one error on purpose: telling
    // them apart tells an attacker whether a token ever existed.
    if (!id) throw new InvalidTokenError();

    // Re-read rather than returning `result.raw`: RETURNING yields raw
    // database columns (`tenant_id`), not hydrated entity properties
    // (`tenantId`), so handing the raw row back would give every caller an
    // object whose fields are quietly the wrong shape.
    return em.findOneByOrFail(this.entities.authToken, { id });
  }

  /**
   * Spends a token and runs work in the same transaction.
   *
   * The safe way to use one: if the work fails, the token is un-spent along
   * with it, so the user's link still works rather than being burned by a
   * failure that was not their fault.
   */
  async consumeWith<T>(
    token: string,
    type: AuthTokenType,
    work: (record: BaseAuthToken, manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    return runInTransaction(this.dataSource, async (manager) => {
      const record = await this.consume(token, type, manager);
      return work(record, manager);
    });
  }

  /** Invalidates every outstanding token of a type for an address. */
  async revokeAll(type: AuthTokenType, email: string, manager?: EntityManager): Promise<number> {
    const result = await this.manager(manager).update(
      this.entities.authToken,
      { type, email: normaliseEmail(email), consumedAt: IsNull() },
      { consumedAt: new Date() },
    );
    return result.affected ?? 0;
  }

  async purgeExpired(now = new Date(), manager?: EntityManager): Promise<number> {
    const result = await this.manager(manager).delete(this.entities.authToken, {
      expiresAt: LessThan(now),
    });
    return result.affected ?? 0;
  }
}
