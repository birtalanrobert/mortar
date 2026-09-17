import { describe, expect, it } from 'vitest';
import { expiresIn, signLink, verifyLink, type LinkPayload } from './index';

const SECRET = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);

const payload = (overrides: Partial<LinkPayload> = {}): LinkPayload => ({
  subject: 'booking:42',
  tenantId: '11111111-1111-4111-8111-111111111111',
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  ...overrides,
});

describe('verifyLink', () => {
  it('accepts a token it signed', async () => {
    const result = await verifyLink(await signLink(payload(), SECRET), SECRET);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.subject).toBe('booking:42');
  });

  it('rejects a token signed with another secret', async () => {
    const result = await verifyLink(await signLink(payload(), OTHER), SECRET);
    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a tampered payload', async () => {
    const token = await signLink(payload(), SECRET);
    const [, signature] = token.split('.');
    const forged = btoa(JSON.stringify(payload({ subject: 'booking:99' })))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    expect(await verifyLink(`${forged}.${signature}`, SECRET)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('reports an expired token as expired, not invalid', async () => {
    // Two different problems with two different remedies: "ask for another"
    // versus "check you copied all of it".
    const stale = await signLink(payload({ expiresAt: Math.floor(Date.now() / 1000) - 1 }), SECRET);
    expect(await verifyLink(stale, SECRET)).toEqual({ ok: false, reason: 'expired' });
  });

  it('reports an expired token that was never ours as invalid', async () => {
    // Checked in this order deliberately. Telling someone their forged token
    // is merely expired invites them to keep trying.
    const stale = await signLink(payload({ expiresAt: Math.floor(Date.now() / 1000) - 1 }), OTHER);
    expect(await verifyLink(stale, SECRET)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a token with no signature', async () => {
    expect(await verifyLink('just-a-payload', SECRET)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a signed token whose payload is not a link', async () => {
    const encoded = btoa(JSON.stringify({ hello: 'world' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const token = await signLink(payload(), SECRET);
    const [, signature] = token.split('.');

    // Signature fails first, which is correct — but the shape check exists for
    // the case where a legitimately signed token predates a field.
    expect((await verifyLink(`${encoded}.${signature}`, SECRET)).ok).toBe(false);
  });

  it('round-trips a payload containing characters outside Latin-1', async () => {
    // Hungarian 'ő' is U+0151. `btoa` only accepts code points up to U+00FF,
    // so an encoder built on it throws on a name a Hungarian tenant actually
    // has — and the failure is at mint time, on a link that should have worked.
    const token = await signLink(payload({ subject: 'előfoglalás-42' }), SECRET);
    const result = await verifyLink(token, SECRET);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.subject).toBe('előfoglalás-42');
  });
});

describe('expiresIn', () => {
  it('is seconds since the epoch, which is what the payload holds', () => {
    const now = new Date('2026-09-17T12:00:00Z');

    /* Seconds rather than milliseconds, and the reason it is a helper: a
       payload built with `Date.now() + 3600` expires in nineteen seventy and
       every link the product mints is dead on arrival. */
    expect(expiresIn(3600, now)).toBe(Math.floor(now.getTime() / 1000) + 3600);
  });
});
