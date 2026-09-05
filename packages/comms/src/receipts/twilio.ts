import { createHmac, timingSafeEqual } from 'node:crypto';
import type { MessageState } from '../message-log.entity';

/** The fields of a status callback this needs. Twilio sends more. */
export interface TwilioStatusCallback {
  MessageSid?: string;
  MessageStatus?: string;
  ErrorCode?: string;
  ErrorMessage?: string;
  [key: string]: string | undefined;
}

export interface TwilioReceipt {
  /** The provider's own identifier, which is what `CommsService.settle` matches on. */
  readonly providerMessageId: string;
  readonly state: Extract<MessageState, 'delivered' | 'bounced' | 'failed'>;
  readonly detail: string | undefined;
}

/**
 * What Twilio says about a message after it accepted it.
 *
 * A provider accepting a message is not the same as a telephone receiving it,
 * and the gap between the two is where a business's "but I sent it" lives. The
 * status callback is the only thing that closes it.
 *
 * ## Verification is the whole of the security here
 *
 * The callback endpoint is unauthenticated by necessity — Twilio has no
 * credential of ours to present — so the signature *is* the authentication.
 * Without it, anybody who learns the URL can mark any message delivered, or
 * bounce a customer's address and stop them being written to again.
 *
 * The scheme is Twilio's: HMAC-SHA1 over the full request URL with every POST
 * parameter appended in sorted key order, keyed by the account's auth token,
 * base64-encoded. Compared with `timingSafeEqual`, because a comparison that
 * returns early is a way to learn a signature one byte at a time.
 */
export class TwilioReceipts {
  constructor(private readonly authToken: string) {}

  /**
   * Whether this really came from Twilio, and what it says.
   *
   * `undefined` rather than a thrown error, for the same reason the inbound
   * verifier returns it: the caller's answer to a request that did not come
   * from the provider is a flat 404, not a message describing what was wrong
   * with the forgery.
   *
   * **The URL must be the one Twilio signed** — the public address including
   * the scheme, host and query string, not the path a proxy handed on. A
   * deployment behind an ingress that rewrites the host will fail every
   * signature until it is passed the address the provider actually called.
   */
  verify(
    url: string,
    params: TwilioStatusCallback,
    signature: string | undefined,
  ): TwilioReceipt | undefined {
    if (!signature) return undefined;

    const expected = this.sign(url, params);
    const offered = Buffer.from(signature);
    const computed = Buffer.from(expected);

    if (offered.length !== computed.length || !timingSafeEqual(offered, computed)) {
      return undefined;
    }

    return interpret(params);
  }

  /** Twilio's own scheme, and the only reason it is here rather than inline. */
  private sign(url: string, params: TwilioStatusCallback): string {
    const payload = Object.keys(params)
      .sort()
      .reduce((joined, key) => joined + key + (params[key] ?? ''), url);

    return createHmac('sha1', this.authToken).update(Buffer.from(payload, 'utf8')).digest('base64');
  }
}

/**
 * What a status means for the log, and what it does not.
 *
 * Twilio reports several states on the way to delivery — `queued`, `sending`,
 * `sent` — and none of them is news: the message was already recorded as
 * accepted when it was handed over. Only the three outcomes are worth writing
 * down, so anything else returns `undefined` and the callback is acknowledged
 * without touching the row.
 *
 * `undelivered` is separated from `failed` deliberately. A message that could
 * not be delivered reached the network and was refused — a disconnected number,
 * a handset that will never come back — which is a fact about the *address* and
 * a reason to stop using it. A failure is a fact about the attempt.
 */
function interpret(params: TwilioStatusCallback): TwilioReceipt | undefined {
  const providerMessageId = params.MessageSid;
  if (!providerMessageId) return undefined;

  const detail = params.ErrorCode
    ? `${params.ErrorCode}: ${params.ErrorMessage ?? 'no description'}`
    : params.ErrorMessage;

  switch (params.MessageStatus) {
    case 'delivered':
      return { providerMessageId, state: 'delivered', detail };
    case 'undelivered':
      return { providerMessageId, state: 'bounced', detail };
    case 'failed':
      return { providerMessageId, state: 'failed', detail };
    default:
      return undefined;
  }
}
