import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * A secret that lives in a column.
 *
 * Third-party refresh tokens, provider credentials, anything a product is given
 * to hold on somebody's behalf. It is *not* for passwords — those are hashed,
 * never encrypted, and `@birtalanrobert/auth` does that — and it is not a
 * substitute for encrypting the disk. It is the layer that means a leaked
 * database dump is not a set of working credentials.
 *
 * **AES-256-GCM.** Authenticated, so a tampered ciphertext fails to open rather
 * than decrypting to rubbish that some code path then uses. The nonce is random
 * per seal and stored with the value, because reusing one with GCM is the
 * mistake that loses the key.
 *
 * The stored form is `v1.<nonce>.<tag>.<ciphertext>`, base64url, with a version
 * at the front: the day the algorithm has to change, the reader can tell which
 * of the two it is looking at, and old rows keep opening while new ones are
 * written the new way.
 */
const VERSION = 'v1';
const NONCE_BYTES = 12;
const KEY_BYTES = 32;

/**
 * The key, from whatever the deployment was given.
 *
 * A hex or base64 string of 32 bytes. Rejected loudly if it is anything else —
 * a short key silently truncated or padded is a key that looks like it is
 * working, and finding out otherwise means every sealed row is unreadable.
 */
export function sealingKey(secret: string): Buffer {
  const key = /^[0-9a-fA-F]{64}$/.test(secret)
    ? Buffer.from(secret, 'hex')
    : Buffer.from(secret, 'base64');

  if (key.length !== KEY_BYTES) {
    throw new Error(
      `A sealing key must be ${KEY_BYTES} bytes: 64 hex characters, or base64 of the same. ` +
        `This one decodes to ${key.length}.`,
    );
  }

  return key;
}

/** Seals a value for storage. */
export function sealSecret(plain: string, key: Buffer): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);

  const sealed = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);

  return [
    VERSION,
    nonce.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    sealed.toString('base64url'),
  ].join('.');
}

/**
 * Opens one, or throws.
 *
 * Throwing rather than returning null is deliberate: every caller of this holds
 * a credential it is about to use, and a silent empty string would be sent to a
 * provider as an empty credential — which fails somewhere far away, with a
 * message about the provider rather than about us.
 */
export function openSecret(sealed: string, key: Buffer): string {
  const [version, nonce, tag, body] = sealed.split('.');

  if (version !== VERSION || !nonce || !tag || !body) {
    throw new Error('That is not a sealed secret, or it was written by a newer release.');
  }

  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));

  return Buffer.concat([
    decipher.update(Buffer.from(body, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/** Whether a stored value is sealed, without opening it. */
export function isSealed(value: string): boolean {
  return value.startsWith(`${VERSION}.`) && value.split('.').length === 4;
}

/**
 * Whether two secrets match, in constant time.
 *
 * For comparing a presented secret against a stored one — a webhook signature,
 * a shared token. A string comparison that returns early is a way to learn the
 * secret one character at a time, slowly, and the attempt costs nothing.
 */
export function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  return left.length === right.length && timingSafeEqual(left, right);
}
