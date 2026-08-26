/**
 * Signed public links.
 *
 * A signed link is how someone outside the system enters a workflow without an
 * account: a client uploading documents, a customer approving a quote, a
 * supplier confirming a delivery. It is the mechanism that makes "no account,
 * ever" possible, and account creation is consistently the single largest cause
 * of people not completing what they were asked to do.
 *
 * The token carries its own claims and is verified by signature, so no database
 * round trip is needed to reject a forgery. Revocation is a separate,
 * deliberate lookup — see `verifyLink`'s `isRevoked`.
 *
 * Web Crypto rather than `node:crypto`, so the same code runs in a Node worker,
 * a Nest request handler, a Next.js server component and an edge runtime.
 */

/** What a link grants, and to whom. */
export interface LinkClaims {
  /**
   * What the link is about, as `type:id` — `request:9f2a…`, `quote:117`.
   *
   * The type prefix is not decoration: it stops a token minted for one kind of
   * entity being accepted by a handler expecting another.
   */
  readonly subject: string;

  /**
   * Which tenant the subject belongs to.
   *
   * Present so the receiving side can bind the tenant before touching data,
   * rather than looking the subject up first and trusting what comes back.
   */
  readonly tenantId: string;

  /**
   * Who this particular link is for, where a subject has several participants.
   *
   * A mortgage application needs documents from two spouses; each gets their
   * own link and sees only their own items. Without this, one party's link
   * opens the other party's documents.
   */
  readonly party?: string;

  /** Seconds since the epoch. */
  readonly expiresAt: number;

  /** Issued-at, seconds since the epoch. Used for age-based policy. */
  readonly issuedAt: number;

  /**
   * A unique id for this token, so one link can be revoked without rotating
   * the secret and invalidating every link in the system.
   */
  readonly jti: string;
}

export type LinkFailure = 'malformed' | 'invalid' | 'expired' | 'revoked';

export type LinkResult =
  | { readonly ok: true; readonly claims: LinkClaims }
  | { readonly ok: false; readonly reason: LinkFailure };

export interface VerifyOptions {
  /**
   * Consulted only after the signature and expiry have passed.
   *
   * Deliberately last: a revocation check is a database round trip, and running
   * it before the signature check would let anyone with a URL make the server
   * do work.
   */
  readonly isRevoked?: (jti: string) => Promise<boolean> | boolean;
  /** Overridable for tests. Seconds since the epoch. */
  readonly now?: () => number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function signLink(
  claims: Omit<LinkClaims, 'issuedAt' | 'jti'> & Partial<Pick<LinkClaims, 'issuedAt' | 'jti'>>,
  secret: string,
): Promise<{ token: string; claims: LinkClaims }> {
  const complete: LinkClaims = {
    ...claims,
    issuedAt: claims.issuedAt ?? Math.floor(Date.now() / 1000),
    jti: claims.jti ?? crypto.randomUUID(),
  };

  const encoded = encodeText(JSON.stringify(complete));
  return { token: `${encoded}.${await sign(encoded, secret)}`, claims: complete };
}

export async function verifyLink(
  token: string,
  secret: string,
  options: VerifyOptions = {},
): Promise<LinkResult> {
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return { ok: false, reason: 'malformed' };

  const expected = await sign(encoded, secret);
  /**
   * Constant-time, and before anything else.
   *
   * A comparison that returns as soon as two bytes differ leaks, through
   * timing, how much of a guessed signature was correct — which is enough to
   * recover one a byte at a time.
   */
  if (!timingSafeEqual(signature, expected)) return { ok: false, reason: 'invalid' };

  let claims: LinkClaims;
  try {
    claims = JSON.parse(decodeText(encoded)) as LinkClaims;
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (!isWellFormed(claims)) return { ok: false, reason: 'malformed' };

  /**
   * Expiry after the signature, deliberately.
   *
   * Reporting a forged token as merely "expired" tells whoever made it that
   * their signature was accepted, which invites them to keep trying.
   */
  const now = options.now?.() ?? Math.floor(Date.now() / 1000);
  if (claims.expiresAt <= now) return { ok: false, reason: 'expired' };

  if (options.isRevoked && (await options.isRevoked(claims.jti))) {
    return { ok: false, reason: 'revoked' };
  }

  return { ok: true, claims };
}

/**
 * Whether a token's claims permit acting on a given subject and party.
 *
 * Called at the point of use, not only at verification. A token that is
 * perfectly valid for one request must not be accepted by a handler that was
 * given a different id in its path — which is the mistake that turns a signed
 * link into an enumeration vulnerability.
 */
export function permits(
  claims: LinkClaims,
  required: { subject: string; party?: string },
): boolean {
  if (claims.subject !== required.subject) return false;
  // A token scoped to a party may act only as that party. An unscoped token
  // covers the whole subject, which is correct when there is only one.
  if (claims.party !== undefined && claims.party !== required.party) return false;
  return true;
}

function isWellFormed(claims: LinkClaims): boolean {
  return (
    typeof claims.subject === 'string' &&
    claims.subject.includes(':') &&
    typeof claims.tenantId === 'string' &&
    claims.tenantId.length > 0 &&
    typeof claims.expiresAt === 'number' &&
    typeof claims.issuedAt === 'number' &&
    typeof claims.jti === 'string' &&
    claims.jti.length > 0 &&
    (claims.party === undefined || typeof claims.party === 'string')
  );
}

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
  // A fixed number of comparisons regardless of length, so that a length
  // mismatch does not itself return faster than a content mismatch.
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
 * over; an encoder that disagreed with the signer about bytes would produce
 * signatures that verify inconsistently.
 */
function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
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

function encodeText(value: string): string {
  return toBase64Url(encoder.encode(value));
}

function decodeText(value: string): string {
  return decoder.decode(fromBase64Url(value));
}
