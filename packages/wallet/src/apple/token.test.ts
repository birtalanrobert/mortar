import { describe, expect, it } from 'vitest';
import {
  passAuthenticationToken,
  readApplePassHeader,
  verifyPassAuthenticationToken,
} from './token';

const SECRET = 'a-deployment-secret-of-reasonable-length';
const SUBJECT = {
  passTypeIdentifier: 'pass.ro.stamped.loyalty',
  serialNumber: '0f9d4b7a-3c21-4f7e-9c2a-8d5e6f1b2c3d',
  version: 1,
};

describe('the per-pass authentication token', () => {
  it('is long enough for Apple and the same every time', () => {
    const token = passAuthenticationToken(SECRET, SUBJECT);

    /* Apple's floor is sixteen characters; this is a 256-bit digest. */
    expect(token.length).toBeGreaterThanOrEqual(16);
    expect(passAuthenticationToken(SECRET, SUBJECT)).toBe(token);
  });

  it('differs per pass, so one leak reaches one card', () => {
    const other = passAuthenticationToken(SECRET, { ...SUBJECT, serialNumber: 'another' });

    expect(other).not.toBe(passAuthenticationToken(SECRET, SUBJECT));
  });

  it('differs per pass type, so two products cannot collide', () => {
    const ticket = passAuthenticationToken(SECRET, {
      ...SUBJECT,
      passTypeIdentifier: 'pass.ro.tickets.event',
    });

    expect(ticket).not.toBe(passAuthenticationToken(SECRET, SUBJECT));
  });

  /**
   * Rotation is a number, which is what "rotated on re-issue" means.
   *
   * A pass issued again after a phone is lost invalidates the one on the lost
   * phone — without a column of secrets to go and update.
   */
  it('is invalidated by bumping the version', () => {
    const first = passAuthenticationToken(SECRET, SUBJECT);
    const second = passAuthenticationToken(SECRET, { ...SUBJECT, version: 2 });

    expect(second).not.toBe(first);
    expect(verifyPassAuthenticationToken(SECRET, { ...SUBJECT, version: 2 }, first)).toBe(false);
  });

  it('is worthless under a different secret', () => {
    const token = passAuthenticationToken(SECRET, SUBJECT);

    // Which is the catastrophe half of the trade: rotating the deployment
    // secret stops every outstanding pass updating. Correct after a leak.
    expect(verifyPassAuthenticationToken('a-different-secret', SUBJECT, token)).toBe(false);
  });

  it('accepts the token it issued and nothing else', () => {
    const token = passAuthenticationToken(SECRET, SUBJECT);

    expect(verifyPassAuthenticationToken(SECRET, SUBJECT, token)).toBe(true);
    expect(verifyPassAuthenticationToken(SECRET, SUBJECT, `${token}x`)).toBe(false);
    expect(verifyPassAuthenticationToken(SECRET, SUBJECT, '')).toBe(false);
    expect(verifyPassAuthenticationToken(SECRET, SUBJECT, token.slice(0, -1))).toBe(false);
  });

  it('does not throw on a length that cannot possibly match', () => {
    /*
     * `timingSafeEqual` throws on a length mismatch, which would turn a
     * malformed header into a 500 — and a 500 that a caller can produce at will
     * by sending one character is a denial of service with extra steps.
     */
    expect(() => verifyPassAuthenticationToken(SECRET, SUBJECT, 'x')).not.toThrow();
    expect(verifyPassAuthenticationToken(SECRET, SUBJECT, 'x')).toBe(false);
  });
});

describe('the Authorization header Apple sends', () => {
  it('reads the token out of it', () => {
    expect(readApplePassHeader('ApplePass abc123')).toBe('abc123');
  });

  it('does not care about the case of the scheme', () => {
    // RFC 9110 says a scheme is case-insensitive, and a device that sends
    // `applepass` is not one we can argue with.
    expect(readApplePassHeader('applepass abc123')).toBe('abc123');
    expect(readApplePassHeader('APPLEPASS abc123')).toBe('abc123');
  });

  it('refuses anything that is not ours', () => {
    expect(readApplePassHeader('Bearer abc123')).toBeNull();
    expect(readApplePassHeader('ApplePass')).toBeNull();
    expect(readApplePassHeader('')).toBeNull();
    expect(readApplePassHeader(undefined)).toBeNull();
  });
});
