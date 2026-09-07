import twilio, { type Twilio } from 'twilio';
import type { MessagePort, OutboundMessage, SendResult } from './port';

export interface WhatsAppMessagePortOptions {
  accountSid: string;
  /** The auth token, or an API key secret paired with `apiKeySid`. */
  authToken: string;
  /** An API key SID, if one is used instead of the account's auth token. */
  apiKeySid?: string;
  /**
   * The WhatsApp sender, in Twilio's own form: `whatsapp:+40…`.
   *
   * A business cannot send from an arbitrary number here the way it can with
   * SMS — the number is registered with Meta, verified, and tied to a display
   * name they approved. That is why there is no per-message `from`.
   */
  from: string;
  /**
   * A messaging service, when one holds the WhatsApp sender.
   *
   * Preferred, for the same reason as SMS: the identity can change without a
   * deployment.
   */
  messagingServiceSid?: string;
  client?: Twilio;
}

interface TwilioFailure {
  status?: number;
  code?: number;
  message?: string;
}

/**
 * Twilio's code for "that number is not on WhatsApp".
 *
 * Worth naming rather than matching on a sentence: it is the one failure that
 * should fall back to SMS rather than being retried, and the difference between
 * a reminder arriving late and a reminder never arriving.
 */
export const NOT_ON_WHATSAPP = 63024;

/**
 * Twilio's code for a message outside the 24-hour window with no template.
 *
 * The other failure worth naming, and the one that catches people: WhatsApp
 * only permits free-form text within twenty-four hours of the *customer's* last
 * message. Everything else must be a template Meta approved in advance.
 */
export const OUTSIDE_WINDOW = 63016;

/**
 * WhatsApp, through Twilio.
 *
 * Beside the SMS and SMTP ports rather than in any product, because four of the
 * seventeen specifications want it and none of them wants a second
 * implementation. Twilio rather than Meta's Cloud API directly: the products
 * that want this already hold Twilio credentials and a credit balance, the SDK
 * is already a dependency here, and template submission and the conversation
 * window are things Twilio already models.
 *
 * ## Three ways WhatsApp is not SMS
 *
 * 1. **You may not say what you like.** Outside twenty-four hours of the
 *    customer's last message, only a template Meta approved in advance may be
 *    sent, with its variables filled in. A reminder is always outside that
 *    window, so a reminder is always a template.
 * 2. **Approval is a fact about the world, not a setting.** A template is
 *    submitted, reviewed by Meta, and may be rejected — per language. A product
 *    has to be able to say "this is waiting for approval" rather than silently
 *    failing to send.
 * 3. **It is billed per conversation, not per message.** A twenty-four hour
 *    conversation costs once however many messages it holds. The ledger here is
 *    debited one unit per message anyway — see `send` — because the provider
 *    does not tell us at send time which conversation a message joined, and
 *    over-counting a reminder that is one message hours from any other is
 *    almost never wrong.
 */
export class WhatsAppMessagePort implements MessagePort {
  readonly channel = 'whatsapp' as const;

  private readonly client: Twilio;

  constructor(private readonly options: WhatsAppMessagePortOptions) {
    if (!options.from && !options.messagingServiceSid) {
      /*
       * Refused at construction. A WhatsApp port with no registered sender is a
       * deployment that fails on the first reminder somebody was relying on,
       * and a configuration mistake is a far better thing to discover at boot.
       */
      throw new Error('WhatsApp needs a registered sender or a messaging service SID.');
    }

    this.client =
      options.client ??
      twilio(options.apiKeySid ?? options.accountSid, options.authToken, {
        accountSid: options.accountSid,
      });
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (message.channel !== 'whatsapp') {
      throw new Error(`This port sends WhatsApp, not ${message.channel}.`);
    }

    let sent;

    try {
      sent = await this.client.messages.create({
        to: address(message.to),
        ...(this.options.messagingServiceSid
          ? { messagingServiceSid: this.options.messagingServiceSid }
          : { from: address(this.options.from) }),
        /*
         * A template if there is one, plain text otherwise.
         *
         * Both are sent — the text is what a delivery receipt and the message
         * log record, and what a business reads back months later when asked
         * what it said. A log holding "template 4 was sent" proves nothing once
         * template 4 has been edited.
         */
        ...(message.template
          ? {
              contentSid: message.template.id,
              contentVariables: JSON.stringify(message.template.variables ?? {}),
            }
          : { body: message.text }),
      });
    } catch (error) {
      const failure = error as TwilioFailure;

      throw new WhatsAppRefused(
        `WhatsApp refused the message (${failure.status ?? 'no status'}` +
          (failure.code ? `, code ${failure.code}` : '') +
          ')' +
          (failure.message ? `: ${failure.message}` : ''),
        failure.code,
        { cause: error },
      );
    }

    return {
      providerMessageId: sent.sid,
      /*
       * One, always.
       *
       * WhatsApp is billed per twenty-four hour conversation rather than per
       * segment, and Twilio does not say at send time which conversation a
       * message joined — so a truthful count is not available here. One per
       * message over-counts only when several fall inside one window, which for
       * a reminder sent hours from anything else is almost never.
       */
      segments: 1,
      acceptedAt: new Date(),
    };
  }
}

/**
 * A refusal that says which one it was.
 *
 * The code matters because two of them mean "try something else" rather than
 * "try again": a number that is not on WhatsApp, and a message outside the
 * window with no template. Both should fall back to SMS, and neither is worth
 * retrying.
 */
export class WhatsAppRefused extends Error {
  constructor(
    message: string,
    readonly code: number | undefined,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WhatsAppRefused';
  }

  /** Whether another channel would do better than another attempt. */
  get worthFallingBack(): boolean {
    return this.code === NOT_ON_WHATSAPP || this.code === OUTSIDE_WINDOW;
  }
}

/**
 * Twilio's addressing, which is a prefix rather than a field.
 *
 * Applied here so no caller has to remember it — a plain `+40…` sent to the
 * WhatsApp endpoint is delivered as an SMS, at SMS prices, and looks like a
 * success everywhere.
 */
const address = (number: string): string =>
  number.startsWith('whatsapp:') ? number : `whatsapp:${number}`;
