import { describe, expect, it, vi } from 'vitest';
import { permits, signLink, verifyLink, type LinkClaims } from './token';

const SECRET = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);
const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;

const claims = (overrides: Partial<LinkClaims> = {}) => ({
  subject: 'request:9f2a',
  tenantId: '11111111-1111-4111-8111-111111111111',
  expiresAt: inAnHour(),
  ...overrides,
});

describe('signLink', () => {
  it('fills in an issued-at and a unique id', async () => {
    const { claims: signed } = await signLink(claims(), SECRET);

    expect(signed.issuedAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    // Without a per-token id, revoking one link would mean rotating the secret
    // and invalidating every link in the system.
    expect(signed.jti).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('gives two links for the same subject different ids', async () => {
    const first = await signLink(claims(), SECRET);
    const second = await signLink(claims(), SECRET);
    expect(first.claims.jti).not.toBe(second.claims.jti);
  });
});

describe('verifyLink', () => {
  it('accepts a token it signed and returns the claims', async () => {
    const { token, claims: signed } = await signLink(claims({ party: 'spouse-a' }), SECRET);
    const result = await verifyLink(token, SECRET);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.subject).toBe('request:9f2a');
      expect(result.claims.party).toBe('spouse-a');
      expect(result.claims.jti).toBe(signed.jti);
    }
  });

  it('rejects a token signed with another secret', async () => {
    const { token } = await signLink(claims(), OTHER);
    expect(await verifyLink(token, SECRET)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a tampered payload', async () => {
    const { token } = await signLink(claims(), SECRET);
    const [, signature] = token.split('.');
    const forged = base64url(JSON.stringify(claims({ subject: 'request:other' })));

    expect(await verifyLink(`${forged}.${signature}`, SECRET)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('reports an expired token as expired', async () => {
    const { token } = await signLink(claims({ expiresAt: 1000 }), SECRET);
    expect(await verifyLink(token, SECRET, { now: () => 2000 })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('reports an expired token that was never ours as invalid', async () => {
    // Telling a forger their token is merely expired confirms the signature was
    // accepted, which invites them to keep trying.
    const { token } = await signLink(claims({ expiresAt: 1000 }), OTHER);
    expect(await verifyLink(token, SECRET, { now: () => 2000 })).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('rejects a malformed token', async () => {
    expect(await verifyLink('nonsense', SECRET)).toEqual({ ok: false, reason: 'malformed' });
    expect(await verifyLink('', SECRET)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a validly-signed payload that is not a link', async () => {
    const encoded = base64url(JSON.stringify({ hello: 'world' }));
    const { token } = await signLink(claims(), SECRET);
    const [, signature] = token.split('.');
    // The signature fails first here; the shape check exists for a token
    // legitimately signed before a field was added.
    expect((await verifyLink(`${encoded}.${signature}`, SECRET)).ok).toBe(false);
  });

  it('round-trips claims containing characters outside Latin-1', async () => {
    // Hungarian 'ő' is U+0151. An encoder built on `btoa` throws on it, and the
    // failure lands at mint time on a link that should have worked.
    const { token } = await signLink(claims({ subject: 'request:előfoglalás' }), SECRET);
    const result = await verifyLink(token, SECRET);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims.subject).toBe('request:előfoglalás');
  });

  describe('revocation', () => {
    it('rejects a revoked token', async () => {
      const { token, claims: signed } = await signLink(claims(), SECRET);
      const isRevoked = vi.fn(async (jti: string) => jti === signed.jti);

      expect(await verifyLink(token, SECRET, { isRevoked })).toEqual({
        ok: false,
        reason: 'revoked',
      });
    });

    it('does not consult the store for a forged token', async () => {
      const isRevoked = vi.fn(async () => false);
      const { token } = await signLink(claims(), OTHER);

      await verifyLink(token, SECRET, { isRevoked });

      // The check is a database round trip. Running it before the signature
      // check would let anyone with a URL make the server do work.
      expect(isRevoked).not.toHaveBeenCalled();
    });

    it('does not consult the store for an expired token', async () => {
      const isRevoked = vi.fn(async () => false);
      const { token } = await signLink(claims({ expiresAt: 1000 }), SECRET);

      await verifyLink(token, SECRET, { isRevoked, now: () => 2000 });
      expect(isRevoked).not.toHaveBeenCalled();
    });
  });
});

describe('permits', () => {
  const base: LinkClaims = {
    subject: 'request:9f2a',
    tenantId: 't1',
    expiresAt: inAnHour(),
    issuedAt: 0,
    jti: 'j1',
  };

  it('allows the subject it was minted for', () => {
    expect(permits(base, { subject: 'request:9f2a' })).toBe(true);
  });

  it('refuses a different subject', () => {
    // The check that stops a valid token being accepted by a handler that was
    // handed a different id in its path.
    expect(permits(base, { subject: 'request:other' })).toBe(false);
  });

  it('refuses a different entity type with the same id', () => {
    expect(permits(base, { subject: 'quote:9f2a' })).toBe(false);
  });

  it('confines a party-scoped token to that party', () => {
    const scoped = { ...base, party: 'spouse-a' };
    expect(permits(scoped, { subject: base.subject, party: 'spouse-a' })).toBe(true);
    // Otherwise one spouse's link opens the other spouse's documents.
    expect(permits(scoped, { subject: base.subject, party: 'spouse-b' })).toBe(false);
    expect(permits(scoped, { subject: base.subject })).toBe(false);
  });

  it('lets an unscoped token cover the whole subject', () => {
    expect(permits(base, { subject: base.subject, party: 'anyone' })).toBe(true);
  });
});

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}
