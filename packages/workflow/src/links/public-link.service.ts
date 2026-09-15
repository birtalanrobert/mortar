import { IsNull, LessThan, type DataSource, type EntityManager } from 'typeorm';
import { resolveManager } from '@birtalanrobert/database';
import { PublicLink } from './public-link.entity';
import { isHandle, mintHandle, signHandle, verifyHandle } from './handle';

export interface PublicLinkOptions {
  /**
   * The signing secret.
   *
   * Shared by whatever mints links and whatever verifies them. In this stack
   * that is the API and the public pages, which are separate deployments — so
   * it is a configured value in both, never derived.
   */
  secret: string;
}

export interface IssueLinkOptions {
  tenantId: string;
  subject: string;
  party?: string;
  /** Null, or omitted, means "as long as the subject exists". */
  expiresAt?: Date | null;
}

export type ResolveFailure = 'malformed' | 'invalid' | 'unknown' | 'expired' | 'revoked';

export type ResolveResult =
  | { readonly ok: true; readonly link: PublicLink }
  | { readonly ok: false; readonly reason: ResolveFailure };

/**
 * Minting, resolving and revoking the short public links.
 *
 * Use this where a link is **printed, scanned or texted** — a status page on a
 * receipt, a QR code in a shop window, a URL inside an SMS — because 37
 * characters is the difference between one segment and three, and between a QR
 * code that reads across a counter and one that does not.
 *
 * Use `LinkService` and `signLink` where a link is **clicked out of an email**
 * and length is free: those tokens carry their claims, so a forgery is rejected
 * with no database involved at all. Neither supersedes the other; they trade
 * length against a round trip, in opposite directions.
 */
export class PublicLinkService {
  private readonly secret: string;

  constructor(
    private readonly dataSource: DataSource,
    options: PublicLinkOptions,
  ) {
    if (!options.secret || options.secret.length < 32) {
      // Refused at construction rather than at first use. A short signing
      // secret is a forgeable link, and finding that out when the first
      // customer opens one is too late.
      throw new Error('PublicLinkService requires a secret of at least 32 characters.');
    }
    this.secret = options.secret;
  }

  private manager(manager?: EntityManager): EntityManager {
    return manager ?? resolveManager(this.dataSource);
  }

  /** A new link for a subject, as the row and the token that reaches it. */
  async issue(
    options: IssueLinkOptions,
    manager?: EntityManager,
  ): Promise<{ token: string; link: PublicLink }> {
    const repository = this.manager(manager).getRepository(PublicLink);

    const link = await repository.save(
      repository.create({
        handle: mintHandle(),
        tenantId: options.tenantId,
        subject: options.subject,
        party: options.party ?? null,
        expiresAt: options.expiresAt ?? null,
        revokedAt: null,
        revokedBy: null,
        reason: null,
      }),
    );

    return { token: await signHandle(link.handle, this.secret), link };
  }

  /**
   * The link a token refers to, or why it cannot be used.
   *
   * **The signature is checked before the database is touched**, so a crawler
   * walking the URL space costs an HMAC rather than a query each time.
   *
   * The failure reasons are distinguished for the *caller's* benefit, not the
   * visitor's: "revoked" and "expired" deserve different words on a page —
   * "this link was replaced, ask for a new one" against "this link has run out"
   * — while a page should never tell a stranger that their forged token was
   * merely unknown rather than badly signed.
   */
  async resolve(token: string, manager?: EntityManager): Promise<ResolveResult> {
    const verified = await verifyHandle(token, this.secret);
    if (!verified.ok) return { ok: false, reason: verified.reason };

    const link = await this.manager(manager)
      .getRepository(PublicLink)
      .findOne({ where: { handle: verified.handle } });

    /*
     * Signed by us and not in the table: the row was deleted with its subject.
     * Distinguished from a forgery because it is a different fact — nothing was
     * attacked, something was cleaned up.
     */
    if (!link) return { ok: false, reason: 'unknown' };
    if (link.revokedAt) return { ok: false, reason: 'revoked' };
    if (link.expiresAt && link.expiresAt.getTime() <= Date.now()) {
      return { ok: false, reason: 'expired' };
    }

    return { ok: true, link };
  }

  /** The live link for a subject, if it has one. */
  async forSubject(
    tenantId: string,
    subject: string,
    manager?: EntityManager,
  ): Promise<PublicLink | null> {
    return this.manager(manager)
      .getRepository(PublicLink)
      .findOne({ where: { tenantId, subject, revokedAt: IsNull() } });
  }

  /** The token for an existing link, for anything that has the row already. */
  async tokenFor(link: PublicLink): Promise<string> {
    return signHandle(link.handle, this.secret);
  }

  /**
   * Stops every live link for a subject working.
   *
   * By subject rather than by handle, because that is what is actually meant: a
   * customer says "somebody else has my link", and the answer is that none of
   * the links to their order work any more, not that one of them does not.
   */
  async revoke(
    tenantId: string,
    subject: string,
    options: { revokedBy?: string; reason?: string } = {},
    manager?: EntityManager,
  ): Promise<number> {
    const result = await this.manager(manager)
      .getRepository(PublicLink)
      .update(
        { tenantId, subject, revokedAt: IsNull() },
        {
          revokedAt: new Date(),
          revokedBy: options.revokedBy ?? null,
          reason: options.reason ?? null,
        },
      );

    return result.affected ?? 0;
  }

  /**
   * Issues a replacement and revokes what it replaces.
   *
   * The two together, because a re-issue that leaves the old link working means
   * a link forwarded to the wrong person stays valid after the customer asks
   * for a new one — which is the situation re-issue exists to fix.
   */
  async reissue(
    options: IssueLinkOptions & { revokedBy?: string },
    manager?: EntityManager,
  ): Promise<{ token: string; link: PublicLink }> {
    await this.revoke(
      options.tenantId,
      options.subject,
      { revokedBy: options.revokedBy, reason: 'superseded' },
      manager,
    );

    return this.issue(options, manager);
  }

  /**
   * Deletes links that expired long enough ago to be of no further interest.
   *
   * Only the *expired* ones: a revoked link is kept, because "this link was
   * revoked" is a better page than "no such link" for the person holding it,
   * and because it is the record of a decision somebody made.
   */
  async sweepExpired(before: Date, manager?: EntityManager): Promise<number> {
    const result = await this.manager(manager)
      .getRepository(PublicLink)
      /*
       * A null expiry is never swept, and SQL does that for us: `NULL < x` is
       * NULL rather than true, so "as long as the subject exists" cannot be
       * caught by a date comparison.
       */
      .delete({ expiresAt: LessThan(before) });

    return result.affected ?? 0;
  }

  /** Whether a value could be a handle at all, for a storage-layer guard. */
  static isHandle(value: string): boolean {
    return isHandle(value);
  }
}
