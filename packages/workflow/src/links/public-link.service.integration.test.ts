import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDataSource } from '@birtalanrobert/database';
import type { DataSource } from 'typeorm';
import { PublicLinkService } from './public-link.service';
import { PublicLink } from './public-link.entity';
import { CreatePublicLink1790600000000 } from '../migrations/1790600000000-CreatePublicLink';

const SECRET = 'a'.repeat(32);
const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

let dataSource: DataSource;
let links: PublicLinkService;

beforeEach(async () => {
  dataSource ??= await createTestDataSource([PublicLink], {
    // The real migration, not `synchronize`: the unique constraint on the
    // handle is the part that matters and synchronize skips half of it.
    migrations: [CreatePublicLink1790600000000],
  });
  await dataSource.getRepository(PublicLink).clear();
  links = new PublicLinkService(dataSource, { secret: SECRET });
});

afterAll(async () => {
  if (dataSource?.isInitialized) await dataSource.destroy();
});

describe('PublicLinkService', () => {
  it('refuses a secret short enough to be guessable', () => {
    expect(() => new PublicLinkService(dataSource, { secret: 'short' })).toThrow(/32 characters/);
  });

  it('issues a short link that resolves to its subject', async () => {
    const { token } = await links.issue({ tenantId: TENANT, subject: 'order:1' });

    expect(token).toHaveLength(37);

    const result = await links.resolve(token);

    expect(result.ok).toBe(true);
    expect(result.ok && result.link.subject).toBe('order:1');
    expect(result.ok && result.link.tenantId).toBe(TENANT);
  });

  /**
   * The lookup a public page depends on, and the reason this table has no
   * row-level security policy.
   *
   * A stranger arrives with a URL and nothing else. If the handle could only be
   * found inside a tenant's policy, there would be no way to discover which
   * tenant to bind — and the query would return nothing, successfully, for
   * every link ever issued.
   */
  it('finds a link without being told which tenant it belongs to', async () => {
    await links.issue({ tenantId: OTHER, subject: 'order:other' });
    const { token } = await links.issue({ tenantId: TENANT, subject: 'order:mine' });

    const result = await links.resolve(token);

    expect(result.ok && result.link.tenantId).toBe(TENANT);
  });

  describe('what it refuses', () => {
    it('refuses a forged token before it reaches the database', async () => {
      expect(await links.resolve(`1${'A'.repeat(36)}`)).toEqual({
        ok: false,
        reason: 'invalid',
      });
    });

    /**
     * Signed by us, and no longer in the table.
     *
     * Distinguished from a forgery because it is a different fact: nothing was
     * attacked, something was cleaned up — and a page can say "this order is no
     * longer available" rather than implying somebody did something wrong.
     */
    it('tells a deleted link apart from a forged one', async () => {
      const { token, link } = await links.issue({ tenantId: TENANT, subject: 'order:1' });
      await dataSource.getRepository(PublicLink).delete({ id: link.id });

      expect(await links.resolve(token)).toEqual({ ok: false, reason: 'unknown' });
    });

    it('refuses a revoked link, and says that is why', async () => {
      const { token } = await links.issue({ tenantId: TENANT, subject: 'order:1' });

      await links.revoke(TENANT, 'order:1', { revokedBy: 'owner', reason: 'customer asked' });

      expect(await links.resolve(token)).toEqual({ ok: false, reason: 'revoked' });
    });

    it('refuses an expired link, and says that is why', async () => {
      const { token } = await links.issue({
        tenantId: TENANT,
        subject: 'order:1',
        expiresAt: new Date(Date.now() - 1_000),
      });

      expect(await links.resolve(token)).toEqual({ ok: false, reason: 'expired' });
    });

    /**
     * A link with no expiry works for as long as its subject does.
     *
     * Null is a real answer rather than a missing one: a status link printed on
     * a receipt should not stop working because somebody invented a lifetime
     * for it.
     */
    it('keeps a link with no expiry working', async () => {
      const { token } = await links.issue({
        tenantId: TENANT,
        subject: 'order:1',
        expiresAt: null,
      });

      expect((await links.resolve(token)).ok).toBe(true);
    });
  });

  describe('revoking', () => {
    /**
     * By subject rather than by handle, because that is what is meant.
     *
     * A customer says "somebody else has my link". The answer has to be that
     * none of the links to their order work any more — not that one of them
     * does not.
     */
    it('stops every live link for one subject', async () => {
      const first = await links.issue({ tenantId: TENANT, subject: 'order:1' });
      const second = await links.issue({ tenantId: TENANT, subject: 'order:1' });
      const untouched = await links.issue({ tenantId: TENANT, subject: 'order:2' });

      expect(await links.revoke(TENANT, 'order:1')).toBe(2);

      expect((await links.resolve(first.token)).ok).toBe(false);
      expect((await links.resolve(second.token)).ok).toBe(false);
      expect((await links.resolve(untouched.token)).ok).toBe(true);
    });

    it('does not reach into another tenant’s links', async () => {
      const theirs = await links.issue({ tenantId: OTHER, subject: 'order:1' });

      await links.revoke(TENANT, 'order:1');

      expect((await links.resolve(theirs.token)).ok).toBe(true);
    });

    /**
     * Re-issue revokes what it replaces, in one call.
     *
     * A re-issue that left the old link working would mean a link forwarded to
     * the wrong person stays valid after the customer asks for a new one, which
     * is precisely the situation re-issue exists to fix.
     */
    it('kills the old link when it issues a new one', async () => {
      const old = await links.issue({ tenantId: TENANT, subject: 'order:1' });
      const fresh = await links.reissue({ tenantId: TENANT, subject: 'order:1' });

      expect(await links.resolve(old.token)).toEqual({ ok: false, reason: 'revoked' });
      expect((await links.resolve(fresh.token)).ok).toBe(true);
    });

    it('is idempotent, because a retry is normal', async () => {
      await links.issue({ tenantId: TENANT, subject: 'order:1' });

      expect(await links.revoke(TENANT, 'order:1')).toBe(1);
      /* The second pass finds nothing live, and that is a success. */
      expect(await links.revoke(TENANT, 'order:1')).toBe(0);
    });
  });

  describe('finding one that already exists', () => {
    it('returns the live link for a subject, and not a revoked one', async () => {
      const first = await links.issue({ tenantId: TENANT, subject: 'order:1' });
      await links.revoke(TENANT, 'order:1');
      const second = await links.issue({ tenantId: TENANT, subject: 'order:1' });

      const found = await links.forSubject(TENANT, 'order:1');

      expect(found?.id).toBe(second.link.id);
      expect(found?.id).not.toBe(first.link.id);
    });

    it('produces the same token for a link it already has', async () => {
      const { token, link } = await links.issue({ tenantId: TENANT, subject: 'order:1' });

      expect(await links.tokenFor(link)).toBe(token);
    });

    it('returns nothing for a subject with no link', async () => {
      expect(await links.forSubject(TENANT, 'order:none')).toBeNull();
    });
  });

  describe('sweeping', () => {
    it('deletes what expired, and keeps what was revoked', async () => {
      await links.issue({
        tenantId: TENANT,
        subject: 'order:expired',
        expiresAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
      });
      await links.issue({ tenantId: TENANT, subject: 'order:revoked' });
      await links.revoke(TENANT, 'order:revoked');

      expect(await links.sweepExpired(new Date())).toBe(1);

      /*
       * "This link was revoked" is a better page than "no such link" for the
       * person holding it, and it is the record of a decision somebody made.
       */
      expect(await dataSource.getRepository(PublicLink).count()).toBe(1);
    });

    /**
     * A link with no expiry is never swept, and SQL does that for us: `NULL <
     * x` is NULL rather than true.
     */
    it('never sweeps a link that was issued without an expiry', async () => {
      await links.issue({ tenantId: TENANT, subject: 'order:forever', expiresAt: null });

      expect(await links.sweepExpired(new Date())).toBe(0);
      expect(await dataSource.getRepository(PublicLink).count()).toBe(1);
    });
  });
});
