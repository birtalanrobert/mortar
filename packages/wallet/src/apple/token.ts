import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The per-pass authentication token, derived rather than stored.
 *
 * Every pass carries a secret in its `pass.json`, and the device sends it back
 * on each of the four update endpoints. The obvious implementation keeps a
 * column of them; this derives each one from a single secret instead, and the
 * difference is worth the paragraph.
 *
 * **Nothing secret is in the database.** A copy of the table — a backup on a
 * laptop, a support query pasted into a chat, a read-only replica — is not a
 * list of every customer's credential.
 *
 * **A rebuilt pass carries the same token.** When a device asks for an updated
 * copy, `pass.json` must contain the token again. A stored hash could not
 * produce it and would force the plaintext to be kept somewhere anyway.
 *
 * **Rotation is a number.** `version` is a column on the pass; incrementing it
 * changes the token, which is what "rotated on re-issue" means. A pass issued
 * again after a phone is lost invalidates the one on the lost phone.
 *
 * The cost is that **the secret is the whole scheme**: change it and every
 * outstanding pass stops being able to update, which is the correct behaviour
 * after a leak and a catastrophe by accident. It belongs in configuration, with
 * the certificate, and never in a repository.
 */
export interface PassTokenSubject {
  passTypeIdentifier: string;
  serialNumber: string;
  /** Incremented to invalidate the token a pass was issued with. Starts at 1. */
  version: number;
}

/**
 * Apple requires at least sixteen characters; this is forty-three.
 *
 * Base64url of a SHA-256 HMAC, which is 256 bits of entropy — a token nobody
 * guesses and nobody has to store.
 */
export function passAuthenticationToken(secret: string, subject: PassTokenSubject): string {
  return createHmac('sha256', secret)
    .update(`${subject.passTypeIdentifier} ${subject.serialNumber} ${subject.version}`)
    .digest('base64url');
}

/**
 * Whether a token the device sent is the one this pass was issued with.
 *
 * Constant time, because the alternative leaks the token a character at a time
 * to anybody willing to send a few thousand requests. `timingSafeEqual` throws
 * on a length mismatch, which is itself a comparison — so the lengths are
 * checked first and a wrong length is simply wrong, which reveals nothing that
 * the token's fixed format did not already.
 */
export function verifyPassAuthenticationToken(
  secret: string,
  subject: PassTokenSubject,
  presented: string,
): boolean {
  const expected = Buffer.from(passAuthenticationToken(secret, subject), 'utf8');
  const actual = Buffer.from(presented, 'utf8');

  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/**
 * The token out of an `Authorization` header, or `null` if it is not one of ours.
 *
 * Apple sends `Authorization: ApplePass <token>`. The scheme is compared
 * case-insensitively because that is what RFC 9110 says of a scheme, and
 * because a device that ever sends `applepass` is not a device we can argue
 * with.
 */
export function readApplePassHeader(header: string | undefined): string | null {
  if (!header) return null;

  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== 'applepass') return null;

  const token = rest.join(' ');
  return token.length > 0 ? token : null;
}
