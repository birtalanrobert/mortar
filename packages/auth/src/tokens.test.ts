import { describe, expect, it } from 'vitest';
import { generateNumericCode, generateToken, hashToken, issueToken, verifyToken } from './tokens';

describe('generateToken', () => {
  it('is URL-safe, so it survives an email link intact', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('never repeats', () => {
    const seen = new Set(Array.from({ length: 1000 }, () => generateToken()));
    expect(seen.size).toBe(1000);
  });

  it('carries 256 bits by default', () => {
    expect(Buffer.from(generateToken(), 'base64url')).toHaveLength(32);
  });
});

describe('hashToken', () => {
  it('does not return the token itself', () => {
    // The stored value must be useless to whoever steals the table.
    const token = generateToken();
    expect(hashToken(token)).not.toBe(token);
  });

  it('is deterministic', () => {
    const token = generateToken();
    expect(hashToken(token)).toBe(hashToken(token));
  });

  it('differs for different tokens', () => {
    expect(hashToken('a')).not.toBe(hashToken('b'));
  });
});

describe('verifyToken', () => {
  it('accepts the matching token', () => {
    const { token, hash } = issueToken();
    expect(verifyToken(token, hash)).toBe(true);
  });

  it('rejects a different token', () => {
    const { hash } = issueToken();
    expect(verifyToken(generateToken(), hash)).toBe(false);
  });

  it('rejects a near-miss', () => {
    const { token, hash } = issueToken();
    expect(verifyToken(`${token.slice(0, -1)}X`, hash)).toBe(false);
  });

  it('rejects the stored hash presented as the token', () => {
    const { hash } = issueToken();
    expect(verifyToken(hash, hash)).toBe(false);
  });

  it('handles malformed input without throwing', () => {
    expect(verifyToken('', '')).toBe(false);
    expect(verifyToken(undefined as unknown as string, 'x')).toBe(false);
    expect(verifyToken('x', undefined as unknown as string)).toBe(false);
  });
});

describe('generateNumericCode', () => {
  it('produces the requested number of digits', () => {
    for (const digits of [4, 6, 8]) {
      expect(generateNumericCode(digits)).toMatch(new RegExp(`^\\d{${digits}}$`));
    }
  });

  it('pads leading zeros rather than shortening the code', () => {
    const codes = Array.from({ length: 3000 }, () => generateNumericCode(4));
    expect(codes.every((c) => c.length === 4)).toBe(true);
  });

  it('is not biased toward low values', () => {
    // Modulo of a random integer without rejection sampling over-represents
    // the low end, and a biased code space is a smaller code space.
    const codes = Array.from({ length: 6000 }, () => Number(generateNumericCode(4)));
    const lowHalf = codes.filter((c) => c < 5000).length;
    expect(lowHalf / codes.length).toBeGreaterThan(0.45);
    expect(lowHalf / codes.length).toBeLessThan(0.55);
  });

  it('refuses lengths outside a sensible range', () => {
    expect(() => generateNumericCode(3)).toThrow();
    expect(() => generateNumericCode(11)).toThrow();
  });
});
