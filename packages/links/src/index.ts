/**
 * Signed, expiring links: how somebody reaches a page without an account.
 *
 * A booking confirmation, an upload request, an RSVP, a loyalty card's web
 * fallback. One side mints a token, the other verifies it, and a shared secret
 * is what makes it unforgeable.
 *
 * **Both halves live here, and that is the whole point of the package.** They
 * must agree exactly on the payload encoding — the bytes the HMAC is computed
 * over, the base64 alphabet, the padding — and two implementations that agree
 * today will not agree in a year. This was written inside a Next.js
 * application when only that application verified them; it moved the moment an
 * API started minting them, which is the rule.
 *
 * **Web Crypto rather than `node:crypto`**, so it runs unchanged in an edge
 * middleware, in a browser and in a Nest service. Node has had `crypto.subtle`
 * as a global since 20.
 *
 * No dependencies, nothing framework-shaped, and nothing that touches a
 * database: what a link *grants* is the consuming product's question, and a
 * package that answered it would need to know about that product's rows.
 */

export interface LinkPayload {
  /** What the link grants access to, as `type:id`. */
  readonly subject: string;
  /** Which tenant it belongs to, so branding and scoping can be resolved. */
  readonly tenantId: string;
  /** Seconds since the epoch. */
  readonly expiresAt: number;
  /** Optional: lets a specific link be revoked without rotating the secret. */
  readonly jti?: string;
}

export type LinkResult =
  | { readonly ok: true; readonly payload: LinkPayload }
  | { readonly ok: false; readonly reason: LinkProblem };

/**
 * Why a token was not accepted.
 *
 * Three rather than one, because they have three different remedies: an
 * expired link means "ask for another", a malformed one means "check you
 * copied all of it", and an invalid one means somebody is guessing. A product
 * where the difference would tell a stranger whether something exists should
 * send all three to the same page — that is the product's decision, and it can
 * only make it if it is told which happened.
 */
export type LinkProblem = 'malformed' | 'invalid' | 'expired';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Mints a token. */
export async function signLink(payload: LinkPayload, secret: string): Promise<string> {
  const encoded = encodeText(JSON.stringify(payload));
  return `${encoded}.${await sign(encoded, secret)}`;
}

/**
 * Checks a token, and says what was wrong when it fails.
 *
 * The order matters: the signature is checked **before** the expiry, so an
 * expired token that we never signed is reported as invalid rather than as
 * merely expired — which would otherwise invite somebody to keep trying with a
 * fresher timestamp.
 */
export async function verifyLink(token: string, secret: string): Promise<LinkResult> {
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return { ok: false, reason: 'malformed' };

  const expected = await sign(encoded, secret);

  /*
   * Constant-time. A byte-by-byte comparison that returns early leaks, through
   * timing, how much of a guessed signature was correct — which is enough to
   * recover one a byte at a time.
   */
  if (!timingSafeEqual(signature, expected)) return { ok: false, reason: 'invalid' };

  let payload: LinkPayload;
  try {
    payload = JSON.parse(decodeText(encoded)) as LinkPayload;
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (typeof payload.expiresAt !== 'number' || !payload.subject || !payload.tenantId) {
    return { ok: false, reason: 'malformed' };
  }

  if (payload.expiresAt * 1000 <= Date.now()) return { ok: false, reason: 'expired' };

  return { ok: true, payload };
}

/** Seconds since the epoch, `seconds` from now. What `expiresAt` wants. */
export const expiresIn = (seconds: number, now: Date = new Date()): number =>
  Math.floor(now.getTime() / 1000) + seconds;

async function sign(encoded: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(encoded));
  return toBase64Url(new Uint8Array(signature));
}

function timingSafeEqual(a: string, b: string): boolean {
  // Compare a fixed number of characters regardless of length, so that a
  // length mismatch does not itself return faster than a content mismatch.
  const length = Math.max(a.length, b.length);
  let differences = a.length === b.length ? 0 : 1;
  for (let index = 0; index < length; index += 1) {
    differences |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return differences === 0;
}

/**
 * Base64url over bytes, never over a string.
 *
 * `btoa` accepts only code points up to U+00FF, so encoding text through it
 * throws on the first `ő` or `ș` — which is to say, on ordinary Hungarian and
 * Romanian. Going through UTF-8 bytes also matches what the HMAC is computed
 * over, and an encoder that disagreed with the signer about bytes would produce
 * signatures that verify inconsistently.
 */
function toBase64Url(bytes: Uint8Array): string {
  let binary = '';

  /* In chunks: spreading a large array into `String.fromCharCode` overflows the
     argument limit, and a signature today is small enough that it would not —
     until something larger is encoded here. */
  const CHUNK = 0x8000;
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '='));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

const encodeText = (value: string): string => toBase64Url(encoder.encode(value));
const decodeText = (value: string): string => decoder.decode(fromBase64Url(value));
