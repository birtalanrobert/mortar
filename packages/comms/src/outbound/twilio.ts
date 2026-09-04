import twilio, { type Twilio } from 'twilio';
import type { MessagePort, OutboundMessage, SendResult } from './port';

export interface TwilioMessagePortOptions {
  accountSid: string;
  /** The auth token, or an API key secret paired with `apiKeySid`. */
  authToken: string;
  /**
   * An API key SID, if one is used instead of the account's auth token.
   *
   * Worth doing: an API key can be revoked on its own, while revoking the auth
   * token invalidates everything the account has.
   */
  apiKeySid?: string;
  /**
   * A messaging service, which is the sender identity done properly.
   *
   * It holds the pool of numbers and sender IDs and picks the right one for the
   * destination country — which matters here because an alphanumeric sender ID
   * is permitted in some markets and not others, and requires registration in
   * Romania. Preferred over `from`, so the identity can change without a
   * deployment.
   */
  messagingServiceSid?: string;
  /** A single sending number, for a deployment with no messaging service. */
  from?: string;
  /** An already-built client, for tests and for a deployment that shares one. */
  client?: Twilio;
}

/** What a `RestException` carries, without depending on the class. */
interface TwilioFailure {
  status?: number;
  code?: number;
  message?: string;
}

/**
 * SMS through Twilio.
 *
 * The provider chosen in dossier's PLAN.md §12 D-1, on the vendor's own SDK —
 * the same arrangement as `@birtalanrobert/files` and `@aws-sdk/client-s3`.
 *
 * Two details of the port's shape exist because of this vendor and are worth
 * keeping when it changes: the sender identity, because it decides whether a
 * client can reply at all, and the segment count, because a credit ledger
 * debited by an estimate rather than by what was charged drifts from the
 * invoice within a month.
 */
export class TwilioMessagePort implements MessagePort {
  readonly channel = 'sms' as const;

  private readonly client: Twilio;

  constructor(private readonly options: TwilioMessagePortOptions) {
    if (!options.messagingServiceSid && !options.from) {
      /**
       * Refused at construction, not at the first message.
       *
       * A port with no sender is a deployment that will fail twelve days into
       * a cadence, on the one message a firm is spending their client's
       * goodwill on. Failing at boot is the difference between a configuration
       * mistake and an incident.
       */
      throw new Error('Twilio needs a messaging service SID or a sending number.');
    }

    this.client =
      options.client ??
      // With an API key it is the key's SID that authenticates and the
      // account's that addresses: a key can be revoked on its own, while
      // revoking the auth token invalidates everything the account has.
      twilio(options.apiKeySid ?? options.accountSid, options.authToken, {
        accountSid: options.accountSid,
      });
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (message.channel !== 'sms') {
      throw new Error(`Twilio sends SMS here, not ${message.channel}.`);
    }

    let sent;
    try {
      sent = await this.client.messages.create({
        to: message.to,
        body: message.text,
        ...(this.options.messagingServiceSid
          ? { messagingServiceSid: this.options.messagingServiceSid }
          : { from: message.from ?? this.options.from! }),
      });
    } catch (error) {
      const failure = error as TwilioFailure;

      // The code as well as the sentence: "21408" is searchable and "Permission
      // to send to this region is disabled" is actionable, and support reads
      // both out of the message log.
      throw new Error(
        `Twilio refused the message (${failure.status ?? 'no status'}` +
          (failure.code ? `, code ${failure.code}` : '') +
          ')' +
          (failure.message ? `: ${failure.message}` : ''),
        // The vendor's own error as the cause: the sentence above is what
        // support reads, and this is what a stack trace needs.
        { cause: error },
      );
    }

    /**
     * The count Twilio charged for, not the one we estimated.
     *
     * `countSegments` in the domain decides whether a message is *worth*
     * sending; this is what the ledger is debited by, and the two differing is
     * exactly the case a ledger exists to catch — an accented character
     * downgrading a message to UCS-2 doubles the cost without changing a word.
     */
    const segments = Number(sent.numSegments ?? '1');

    return {
      providerMessageId: sent.sid,
      segments: Number.isFinite(segments) && segments > 0 ? segments : 1,
      acceptedAt: new Date(),
    };
  }
}
