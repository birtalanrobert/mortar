import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDataSource } from '@birtalanrobert/database';
import type { DataSource } from 'typeorm';
import { LinkService } from './link.service';
import { LinkRevocation } from './revocation.entity';
import { CreateLinkRevocation1787754027798 } from '../migrations/1787754027798-CreateLinkRevocation';

const SECRET = 'a'.repeat(32);
const TENANT = '11111111-1111-4111-8111-111111111111';

let dataSource: DataSource;
let links: LinkService;

beforeEach(async () => {
  dataSource ??= await createTestDataSource([LinkRevocation], {
    // The real migration, not `synchronize`: the indexes and the unique
    // constraint are the parts that matter and synchronize skips half of it.
    migrations: [CreateLinkRevocation1787754027798],
  });
  await dataSource.getRepository(LinkRevocation).clear();
  links = new LinkService(dataSource, { secret: SECRET });
});

afterAll(async () => {
  if (dataSource?.isInitialized) await dataSource.destroy();
});

describe('LinkService', () => {
  it('refuses a secret short enough to be guessable', () => {
    // At construction, not at first use. Finding out when the first client
    // opens a link is too late.
    expect(() => new LinkService(dataSource, { secret: 'short' })).toThrow(/32 characters/);
  });

  it('issues a link that verifies', async () => {
    const { token } = await links.issue({ subject: 'request:1', tenantId: TENANT });
    const result = await links.verify(token);

    expect(result.ok).toBe(true);
  });

  it('rejects a link after it is revoked', async () => {
    const { token, claims } = await links.issue({ subject: 'request:1', tenantId: TENANT });
    expect((await links.verify(token)).ok).toBe(true);

    await links.revoke(claims, { revokedBy: 'user-1', reason: 'client asked for a new one' });

    expect(await links.verify(token)).toEqual({ ok: false, reason: 'revoked' });
  });

  it('tolerates revoking the same link twice', async () => {
    const { claims } = await links.issue({ subject: 'request:1', tenantId: TENANT });

    await links.revoke(claims);
    // A retry is normal; the unique constraint would otherwise make it an error.
    await expect(links.revoke(claims)).resolves.toBeUndefined();

    expect(await dataSource.getRepository(LinkRevocation).count()).toBe(1);
  });

  it('re-issue invalidates the link it replaces', async () => {
    const first = await links.issue({ subject: 'request:1', tenantId: TENANT, party: 'p1' });
    const second = await links.reissue(first.claims, { revokedBy: 'user-1' });

    /**
     * The property re-issue exists for.
     *
     * A client who forwarded their link to the wrong person asks for a new one.
     * If the old one keeps working, nothing has been fixed.
     */
    expect(await links.verify(first.token)).toEqual({ ok: false, reason: 'revoked' });
    expect((await links.verify(second.token)).ok).toBe(true);
  });

  it('re-issue keeps the subject and the party scope', async () => {
    const first = await links.issue({ subject: 'request:1', tenantId: TENANT, party: 'spouse-a' });
    const second = await links.reissue(first.claims);

    expect(second.claims.subject).toBe('request:1');
    // Otherwise a re-issued link would silently widen to the whole request.
    expect(second.claims.party).toBe('spouse-a');
  });

  it('sweeps revocations for tokens that have expired anyway', async () => {
    const stale = await links.issue({ subject: 'request:1', tenantId: TENANT, ttlMs: 1000 });
    const live = await links.issue({ subject: 'request:2', tenantId: TENANT });
    await links.revoke(stale.claims);
    await links.revoke(live.claims);

    const removed = await links.sweepExpired(new Date(Date.now() + 60_000));

    // Safe: an expired token is rejected on expiry whether or not a revocation
    // row survives. The table is otherwise unbounded.
    expect(removed).toBe(1);
    expect(await links.isRevoked(live.claims.jti)).toBe(true);
  });
});
