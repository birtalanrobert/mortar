import { fromBase64Url, hmac, timingSafeEqual, toBase64Url } from './encoding';

/**
 * A public link short enough to send in a text message.
 *
 * `signLink` carries its claims inside the token, which is the right trade for
 * an email link: no database round trip is needed to reject a forgery. It costs
 * length — a subject, a tenant, an expiry and a token id, as JSON, in base64,
 * with a signature, is **over three hundred characters**. In an SMS that is two
 * segments spent on the URL alone, before a single word of the message; as a QR
 * code on a shop window it is a dense square that a phone struggles to read
 * across a counter.
 *
 * So for a link that must be *printed, scanned and texted*, the claims move to
 * a row and the token becomes a **handle plus a short signature: 37
 * characters**. The trade is one indexed lookup per visit, which the page was
 * making anyway — it has to read the order to render it, and it has to check
 * revocation, which is a row whichever format is used.
 *
 * ```
 *   1  aB3kF9xQ7tL2mN8pR4sV6w  Xk2mP9vR4tQ7nZ
 *   ▲  ▲                       ▲
 *   │  │                       └─ 80-bit tag: rejects a guess without a query
 *   │  └───────────────────────── 128 random bits: what makes it unguessable
 *   └──────────────────────────── format version, so this can ever change
 * ```
 *
 * **What the signature is for, given the handle is already unguessable.** Not
 * secrecy — 128 random bits is not going to be guessed. It is so that a crawler
 * or a scanner hitting `/s/<rubbish>` a million times is refused in microseconds
 * by an HMAC rather than costing a database query each time. The handle is the
 * security; the tag is the doorman.
 *
 * Pure Web Crypto, so a Next.js server component can reject a bad token before
 * it opens a connection.
 */

/** The format this module writes. Present so a later one can be told apart. */
const VERSION = '1';

/** 16 bytes: 128 bits of randomness, which is 22 base64url characters. */
const HANDLE_BYTES = 16;

/**
 * 10 bytes of the HMAC, which is 14 base64url characters.
 *
 * Truncation is standard practice and the length is chosen for the job: 80 bits
 * is far beyond forging, and the real barrier is the handle behind it. Spending
 * 43 characters on a full SHA-256 would buy nothing and cost a third of the SMS
 * budget this format exists to protect.
 */
const TAG_BYTES = 10;

const HANDLE_LENGTH = 22;
const TAG_LENGTH = 14;

/** What a complete token measures, for anything sizing a column or a QR code. */
export const LINK_TOKEN_LENGTH = VERSION.length + HANDLE_LENGTH + TAG_LENGTH;

/** How wide a column storing a handle needs to be. */
export const LINK_HANDLE_LENGTH = HANDLE_LENGTH;

export type HandleFailure = 'malformed' | 'invalid';

export type HandleResult =
  | { readonly ok: true; readonly handle: string }
  | { readonly ok: false; readonly reason: HandleFailure };

/**
 * A new, unguessable handle.
 *
 * `crypto.getRandomValues` rather than a uuid: a uuid spends six of its bits on
 * version and variant markers and costs 36 characters to write down, where the
 * same 16 bytes are 22.
 */
export function mintHandle(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(HANDLE_BYTES)));
}

/** The token for a handle — what actually goes in the URL. */
export async function signHandle(handle: string, secret: string): Promise<string> {
  return `${VERSION}${handle}${await tagFor(handle, secret)}`;
}

/**
 * Splits a token and checks its signature, with no database involved.
 *
 * A `handle` coming back means the token is well-formed and was minted with
 * this secret. It does **not** mean the link is live: whether it exists, has
 * been revoked or has expired is the row's business, and `PublicLinkService`
 * asks.
 */
export async function verifyHandle(token: string, secret: string): Promise<HandleResult> {
  if (token.length !== LINK_TOKEN_LENGTH || !token.startsWith(VERSION)) {
    return { ok: false, reason: 'malformed' };
  }

  const handle = token.slice(VERSION.length, VERSION.length + HANDLE_LENGTH);
  const tag = token.slice(VERSION.length + HANDLE_LENGTH);

  /*
   * Checked before the handle is used for anything. A token whose characters
   * are outside the alphabet cannot have been minted here, and decoding it
   * would be doing work on somebody else's behalf.
   */
  if (!/^[A-Za-z0-9_-]+$/.test(handle) || !/^[A-Za-z0-9_-]+$/.test(tag)) {
    return { ok: false, reason: 'malformed' };
  }

  if (!timingSafeEqual(tag, await tagFor(handle, secret))) {
    return { ok: false, reason: 'invalid' };
  }

  return { ok: true, handle };
}

async function tagFor(handle: string, secret: string): Promise<string> {
  /*
   * The version is signed along with the handle, so a token cannot be replayed
   * against a future format that reads the same characters differently.
   */
  const signature = await hmac(`${VERSION}${handle}`, secret);
  return toBase64Url(signature.subarray(0, TAG_BYTES));
}

/**
 * Whether a string could be a handle this module minted.
 *
 * For the storage layer, which should refuse a malformed value before it
 * reaches a query rather than after.
 */
export function isHandle(value: string): boolean {
  if (value.length !== HANDLE_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    return fromBase64Url(value).length === HANDLE_BYTES;
  } catch {
    return false;
  }
}
