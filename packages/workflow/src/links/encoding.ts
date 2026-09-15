/**
 * The byte-level parts both link formats share.
 *
 * Extracted rather than written twice: a second `toBase64Url` is a second
 * opinion about what bytes a signature covers, and two such opinions produce
 * signatures that verify inconsistently — the kind of fault that appears months
 * later, for one customer, on one link.
 *
 * Web Crypto rather than `node:crypto`, so the same code runs in a Node worker,
 * a Nest request handler, a Next.js server component and an edge runtime.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Base64url over bytes, never over a string.
 *
 * `btoa` accepts only code points up to U+00FF, so encoding text through it
 * throws on the first `ő` or `ș` — which is to say, on ordinary Hungarian and
 * Romanian. Going through UTF-8 bytes also matches what an HMAC is computed
 * over; an encoder that disagreed with the signer about bytes would produce
 * signatures that verify inconsistently.
 */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '='));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function encodeText(value: string): string {
  return toBase64Url(encoder.encode(value));
}

export function decodeText(value: string): string {
  return decoder.decode(fromBase64Url(value));
}

/** HMAC-SHA256 over the UTF-8 bytes of `message`, as raw bytes. */
export async function hmac(message: string, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

/**
 * A comparison that takes the same time whatever the answer.
 *
 * One that returns as soon as two characters differ leaks, through timing, how
 * much of a guessed signature was correct — which is enough to recover one a
 * character at a time.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  // A fixed number of comparisons regardless of length, so that a length
  // mismatch does not itself return faster than a content mismatch.
  const length = Math.max(a.length, b.length);
  let differences = a.length === b.length ? 0 : 1;
  for (let index = 0; index < length; index += 1) {
    differences |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return differences === 0;
}
