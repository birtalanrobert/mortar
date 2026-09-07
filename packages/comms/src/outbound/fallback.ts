import type { Channel, MessagePort, OutboundMessage, SendResult } from './port';
import { WhatsAppRefused } from './whatsapp';

/**
 * A port that tries one channel and then another.
 *
 * Built for WhatsApp and general on purpose. A reminder that cannot be
 * delivered on the channel a business prefers must still arrive: a customer who
 * is not on WhatsApp, or whose twenty-four hour window has closed with no
 * approved template, is a customer who still has an appointment tomorrow.
 *
 * **Falling back is not retrying.** The two failures worth falling back on say
 * "this channel will never work for this person" — trying again would fail
 * identically, and delaying is worse than switching. Everything else is a
 * failure the caller should see: a wrong credential must not quietly send every
 * message by SMS at SMS prices while looking like it worked.
 */
export class FallbackMessagePort implements MessagePort {
  constructor(
    private readonly preferred: MessagePort,
    private readonly fallback: MessagePort,
    /** Told what happened, so a product can say "sent by SMS instead". */
    private readonly onFallback?: (message: OutboundMessage, reason: string) => void,
  ) {}

  get channel(): Channel {
    return this.preferred.channel;
  }

  get fallbackChannel(): Channel {
    return this.fallback.channel;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    try {
      return await this.preferred.send(message);
    } catch (error) {
      if (!worthFallingBack(error)) throw error;

      this.onFallback?.(message, error instanceof Error ? error.message : String(error));

      /*
       * The same words, on the other channel.
       *
       * The template is dropped rather than carried across: it belongs to the
       * channel that required it, and an SMS port handed one would either
       * ignore it or send its identifier as the message.
       */
      const { template: _template, ...plain } = message;

      const result = await this.fallback.send({ ...plain, channel: this.fallback.channel });

      /*
       * Named in the result, so the log and the ledger record what happened.
       *
       * Without this the whole diversion is invisible above the port: a message
       * log saying WhatsApp for something that went by SMS, and a business
       * asking why it was billed for texts it did not send.
       */
      return { ...result, channel: this.fallback.channel };
    }
  }
}

/**
 * Whether another channel would do better than another attempt.
 *
 * Narrow on purpose. A provider having an afternoon, a wrong credential, a
 * malformed request — none of those is helped by a different channel, and
 * silently sending everything by SMS because a token expired is a bill nobody
 * expected and a fault nobody saw.
 */
function worthFallingBack(error: unknown): boolean {
  return error instanceof WhatsAppRefused && error.worthFallingBack;
}
