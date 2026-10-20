import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords (RFC 6238): the six digits an authenticator
 * app shows, changing every thirty seconds.
 *
 * HMAC-SHA1, thirty seconds and six digits — not because they are the
 * strongest choices but because they are the ones every authenticator app
 * honours. An app that ignores `algorithm=SHA256` in the link silently shows
 * codes that never match, and the person enrolling finds out by being locked
 * out. The strength is in the secret's 160 bits and in refusing a code twice,
 * not in the hash.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** How long a code lives. */
export const TOTP_PERIOD_SECONDS = 30;

/** How many digits a code has. */
export const TOTP_DIGITS = 6;

/** 160 bits: the length RFC 4226 recommends for an HMAC-SHA1 key. */
export const TOTP_SECRET_BYTES = 20;

/** A new secret, base32 as an authenticator app is given it. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(TOTP_SECRET_BYTES));
}

/** Bytes as RFC 4648 base32, upper-case and unpadded — how authenticator apps take a key. */
export function base32Encode(bytes: Uint8Array): string {
  let value = 0;
  let bits = 0;
  let out = '';
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * A base32 key back to its bytes. Spaces, dashes, padding and case are
 * forgiven — people copy keys in groups — and anything else is refused.
 */
export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase();
  const bytes: number[] = [];
  let value = 0;
  let bits = 0;
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error('Not a base32 key.');
    value = ((value << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** The time step a moment falls in: the counter the code for it is made from. */
export function totpStep(atMs: number, periodSeconds = TOTP_PERIOD_SECONDS): number {
  return Math.floor(atMs / 1000 / periodSeconds);
}

/** The code for one time step (RFC 4226's HOTP over the step as its counter). */
export function totpCode(secret: Buffer, step: number, digits = TOTP_DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', secret).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * The time step a code was made for, within `window` steps either side of the
 * one `atMs` falls in — a phone's clock a little off, or a code typed as it
 * turned — or null for a code that matches none. The caller refuses a step it
 * has seen before: a code is good once.
 */
export function matchTotpStep(
  secret: Buffer,
  code: string,
  atMs: number,
  options: { window?: number; periodSeconds?: number; digits?: number } = {},
): number | null {
  const { window = 1, periodSeconds = TOTP_PERIOD_SECONDS, digits = TOTP_DIGITS } = options;
  const given = code.replace(/\s/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(given)) return null;

  const now = totpStep(atMs, periodSeconds);
  for (let step = now - window; step <= now + window; step += 1) {
    if (step < 0) continue;
    const expected = totpCode(secret, step, digits);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(given))) return step;
  }
  return null;
}

/**
 * The `otpauth://` link an authenticator app enrols from — a QR code of it, or
 * the link itself on a phone. The issuer is named twice, as the label's prefix
 * and as a parameter, because apps disagree about which one they read.
 */
export function otpauthUri(input: {
  readonly issuer: string;
  readonly account: string;
  readonly secret: string;
}): string {
  const issuer = encodeURIComponent(input.issuer);
  const label = `${issuer}:${encodeURIComponent(input.account)}`;
  return (
    `otpauth://totp/${label}?secret=${input.secret}&issuer=${issuer}` +
    `&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`
  );
}
