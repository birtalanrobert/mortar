import { getContext } from '@mortar/context';
import { resolveManager } from '@mortar/database';
import { IsNull, LessThan, type DataSource, type EntityManager } from 'typeorm';
import type { BaseSession } from '../entities/session';
import { resolveRegistry, type AuthEntityRegistry } from '../registry';
import { SessionExpiredError } from '../errors';
import { hashToken, issueToken } from '../tokens';

export interface SessionOptions {
  /** Override when the project registers its own entity subclasses. */
  entities?: Partial<AuthEntityRegistry>;
  /** Absolute lifetime, regardless of activity. Default 30 days. */
  absoluteTtlMs?: number;
  /** Inactivity before expiry. Default 14 days. */
  idleTtlMs?: number;
  /** How stale `lastSeenAt` may get before it is written. Default 60s. */
  touchIntervalMs?: number;
}

export interface CreatedSession {
  /** Give to the client. Never stored. */
  readonly token: string;
  readonly session: BaseSession;
}

/**
 * Opaque server-side sessions.
 *
 * Opaque rather than a self-contained JWT, deliberately. Every project in this
 * catalogue needs to revoke access immediately — a dismissed employee, a lost
 * counter tablet, a compromised account, a suspended tenant — and a stateless
 * token cannot be revoked without building the very lookup table it was
 * supposed to avoid. The lookup is one indexed read.
 */
export class SessionService {
  private readonly absoluteTtlMs: number;
  private readonly idleTtlMs: number;
  private readonly touchIntervalMs: number;
  private readonly entities: AuthEntityRegistry;

  constructor(
    private readonly dataSource: DataSource,
    options: SessionOptions = {},
  ) {
    this.entities = resolveRegistry(options.entities);
    this.absoluteTtlMs = options.absoluteTtlMs ?? 30 * 24 * 60 * 60 * 1000;
    this.idleTtlMs = options.idleTtlMs ?? 14 * 24 * 60 * 60 * 1000;
    this.touchIntervalMs = options.touchIntervalMs ?? 60 * 1000;
  }

  private manager(explicit?: EntityManager): EntityManager {
    return explicit ?? resolveManager(this.dataSource);
  }

  async create(
    userId: string,
    options: { tenantId?: string | null; ttlMs?: number } = {},
    manager?: EntityManager,
  ): Promise<CreatedSession> {
    const context = getContext();
    const { token, hash } = issueToken();
    const now = new Date();

    const session = this.manager(manager).create(this.entities.session, {
      userId,
      tokenHash: hash,
      tenantId: options.tenantId ?? null,
      expiresAt: new Date(now.getTime() + (options.ttlMs ?? this.absoluteTtlMs)),
      lastSeenAt: now,
      ip: context?.ip ?? null,
      userAgent: context?.userAgent?.slice(0, 512) ?? null,
      revokedAt: null,
      revokedReason: null,
    });

    return { token, session: await this.manager(manager).save(this.entities.session, session) };
  }

  /**
   * Resolves a token to a live session, or throws.
   *
   * Enforces both lifetimes: a session dies at its absolute expiry however
   * active it has been, and dies early if idle. A shared counter tablet left
   * signed in overnight should not stay valid because somebody touched it at
   * closing time.
   */
  async validate(token: string, manager?: EntityManager): Promise<BaseSession> {
    const em = this.manager(manager);
    const session = await em.findOne(this.entities.session, {
      where: { tokenHash: hashToken(token) },
    });
    const now = new Date();

    if (
      !session ||
      session.revokedAt !== null ||
      session.expiresAt <= now ||
      now.getTime() - session.lastSeenAt.getTime() > this.idleTtlMs
    ) {
      throw new SessionExpiredError();
    }

    // Written only occasionally: touching on every request turns a read-only
    // path into a write on every single call, which is a great deal of I/O to
    // record that somebody is still there.
    if (now.getTime() - session.lastSeenAt.getTime() > this.touchIntervalMs) {
      session.lastSeenAt = now;
      await em.update(this.entities.session, { id: session.id }, { lastSeenAt: now });
    }

    return session;
  }

  /**
   * Issues a new token for an existing session and invalidates the old one.
   *
   * Call on any privilege change — signing in, switching tenant, elevating a
   * role. Keeping the same token across a privilege boundary is session
   * fixation: an attacker who plants a token before the change holds a valid
   * one after it.
   */
  async rotate(session: BaseSession, manager?: EntityManager): Promise<CreatedSession> {
    const em = this.manager(manager);
    const { token, hash } = issueToken();
    session.tokenHash = hash;
    session.lastSeenAt = new Date();
    return { token, session: await em.save(this.entities.session, session) };
  }

  async switchTenant(
    session: BaseSession,
    tenantId: string | null,
    manager?: EntityManager,
  ): Promise<CreatedSession> {
    session.tenantId = tenantId;
    return this.rotate(session, manager);
  }

  async revoke(sessionId: string, reason = 'signed_out', manager?: EntityManager): Promise<void> {
    await this.manager(manager).update(
      this.entities.session,
      { id: sessionId, revokedAt: IsNull() },
      { revokedAt: new Date(), revokedReason: reason },
    );
  }

  /**
   * Revokes every session for a user.
   *
   * The action behind "sign out everywhere", and the required response to a
   * password change or a compromised account — leaving other sessions alive
   * after a password reset means the attacker keeps their access.
   */
  async revokeAllForUser(
    userId: string,
    reason = 'revoked',
    options: { exceptSessionId?: string } = {},
    manager?: EntityManager,
  ): Promise<number> {
    const qb = this.manager(manager)
      .createQueryBuilder()
      .update(this.entities.session)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where('user_id = :userId', { userId })
      .andWhere('revoked_at IS NULL');

    if (options.exceptSessionId) {
      qb.andWhere('id <> :except', { except: options.exceptSessionId });
    }

    return (await qb.execute()).affected ?? 0;
  }

  async listForUser(userId: string, manager?: EntityManager): Promise<BaseSession[]> {
    return this.manager(manager).find(this.entities.session, {
      where: { userId },
      order: { lastSeenAt: 'DESC' },
    });
  }

  /** Deletes expired and revoked sessions. Safe to run on a schedule. */
  async purgeExpired(now = new Date(), manager?: EntityManager): Promise<number> {
    const result = await this.manager(manager).delete(this.entities.session, {
      expiresAt: LessThan(now),
    });
    return result.affected ?? 0;
  }
}
