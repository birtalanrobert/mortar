import { LessThan, type DataSource, type EntityManager } from 'typeorm';
import { resolveManager } from '@birtalanrobert/database';
import { LinkRevocation } from './revocation.entity';
import { signLink, verifyLink, type LinkClaims, type LinkResult } from './token';

export interface LinkServiceOptions {
  /**
   * The signing secret.
   *
   * Shared by whatever mints links and whatever verifies them. In this stack
   * that is the API and the public pages, which are separate deployments — so
   * it is a configured value in both, never derived.
   */
  secret: string;
  /** Default lifetime for a minted link. */
  defaultTtlMs?: number;
}

export interface IssueOptions {
  subject: string;
  tenantId: string;
  party?: string;
  ttlMs?: number;
}

/** Thirty days: long enough for a client who is slow, short enough to matter. */
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Minting, verifying and revoking public links, backed by a revocation table.
 *
 * The pure `signLink` and `verifyLink` remain the interface for anything with
 * no database — a Next.js page verifying a token before rendering, say. This
 * adds the one thing that genuinely needs storage.
 */
export class LinkService {
  private readonly secret: string;
  private readonly defaultTtlMs: number;

  constructor(
    private readonly dataSource: DataSource,
    options: LinkServiceOptions,
  ) {
    if (!options.secret || options.secret.length < 32) {
      // Refused at construction rather than at first use. A short signing
      // secret is a forgeable link, and finding that out when the first client
      // opens one is too late.
      throw new Error('LinkService requires a secret of at least 32 characters.');
    }
    this.secret = options.secret;
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
  }

  private manager(manager?: EntityManager): EntityManager {
    return manager ?? resolveManager(this.dataSource);
  }

  async issue(options: IssueOptions): Promise<{ token: string; claims: LinkClaims }> {
    const ttl = options.ttlMs ?? this.defaultTtlMs;
    return signLink(
      {
        subject: options.subject,
        tenantId: options.tenantId,
        party: options.party,
        expiresAt: Math.floor((Date.now() + ttl) / 1000),
      },
      this.secret,
    );
  }

  /**
   * Issues a replacement and revokes the one it replaces.
   *
   * The two together, because a re-issue that leaves the old link working means
   * a link forwarded to the wrong person stays valid after the client asks for
   * a new one — which is the situation re-issue exists to fix.
   */
  async reissue(
    previous: LinkClaims,
    options: { revokedBy?: string; ttlMs?: number } = {},
  ): Promise<{ token: string; claims: LinkClaims }> {
    await this.revoke(previous, { revokedBy: options.revokedBy, reason: 'superseded' });
    return this.issue({
      subject: previous.subject,
      tenantId: previous.tenantId,
      party: previous.party,
      ttlMs: options.ttlMs,
    });
  }

  async verify(token: string, manager?: EntityManager): Promise<LinkResult> {
    return verifyLink(token, this.secret, {
      isRevoked: (jti) => this.isRevoked(jti, manager),
    });
  }

  async isRevoked(jti: string, manager?: EntityManager): Promise<boolean> {
    return this.manager(manager).getRepository(LinkRevocation).exists({ where: { jti } });
  }

  async revoke(
    claims: LinkClaims,
    options: { revokedBy?: string; reason?: string } = {},
    manager?: EntityManager,
  ): Promise<void> {
    const repository = this.manager(manager).getRepository(LinkRevocation);

    // Idempotent: revoking twice is a normal consequence of a retry, and the
    // unique constraint on jti would otherwise turn it into an error.
    if (await repository.exists({ where: { jti: claims.jti } })) return;

    await repository.save(
      repository.create({
        tenantId: claims.tenantId,
        jti: claims.jti,
        subject: claims.subject,
        party: claims.party ?? null,
        revokedBy: options.revokedBy ?? null,
        reason: options.reason ?? null,
        expiresAt: new Date(claims.expiresAt * 1000),
      }),
    );
  }

  /**
   * Deletes revocations for tokens that have expired anyway.
   *
   * Safe because an expired token is rejected on expiry regardless of whether
   * a revocation row survives. Run on a schedule; the table is otherwise
   * unbounded.
   */
  async sweepExpired(before = new Date(), manager?: EntityManager): Promise<number> {
    const result = await this.manager(manager)
      .getRepository(LinkRevocation)
      .delete({ expiresAt: LessThan(before) });
    return result.affected ?? 0;
  }
}
