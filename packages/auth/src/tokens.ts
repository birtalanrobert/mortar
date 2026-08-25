import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * A freshly minted token: the secret to send, and the digest to store.
 *
 * They are deliberately different values. See `hashToken`.
 */
export interface IssuedToken {
  /** Sent to the user. Never stored anywhere. */
  readonly token: string;
  /** Stored. Useless to an attacker who obtains it. */
  readonly hash: string;
}

/** Bytes of entropy in a generated token. 32 is 256 bits. */
const TOKEN_BYTES = 32;

/**
 * Generates a URL-safe random token.
 *
 * base64url rather than hex: same entropy in a third fewer characters, and no
 * percent-encoding when it lands in a link — which matters because these
 * tokens travel in emails and SMS, where every character costs money and every
 * line break risks a broken link.
 */
export function generateToken(bytes = TOKEN_BYTES): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Hashes a token for storage.
 *
 * Plain SHA-256, deliberately, and **not** a password hash: tokens are
 * high-entropy random values, so there is nothing to brute-force and the slow
 * KDF would buy nothing while making every verification expensive.
 *
 * What matters is that the stored value is *not* the token. A leaked sessions
 * table full of usable session tokens is an immediate compromise of every
 * logged-in user; a table of digests is not.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

/** Issues a token and its digest together. */
export function issueToken(bytes = TOKEN_BYTES): IssuedToken {
  const token = generateToken(bytes);
  return { token, hash: hashToken(token) };
}

/**
 * Compares a presented token against a stored digest, in constant time.
 *
 * A plain `===` on the digest leaks its prefix through timing. The window is
 * small, but the fix is one function call.
 */
export function verifyToken(presented: string, storedHash: string): boolean {
  if (typeof presented !== 'string' || typeof storedHash !== 'string') return false;
  const a = Buffer.from(hashToken(presented));
  const b = Buffer.from(storedHash);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Generates a short numeric code, for SMS and for reading aloud.
 *
 * Materially weaker than a token by construction — a six-digit code has about
 * twenty bits of entropy — so anything using one **must** be rate limited and
 * short-lived. Used where a link is impractical: a phone-number login, a
 * collection confirmation read over the counter.
 */
export function generateNumericCode(digits = 6): string {
  if (digits < 4 || digits > 10) {
    throw new Error('Numeric codes must be between 4 and 10 digits.');
  }
  const max = 10 ** digits;
  // Rejection sampling: the naive modulo of a random integer biases the low
  // codes, and a biased code space is a smaller code space.
  const limit = Math.floor(0xffffffff / max) * max;
  let value: number;
  do {
    value = randomBytes(4).readUInt32BE(0);
  } while (value >= limit);
  return String(value % max).padStart(digits, '0');
}
