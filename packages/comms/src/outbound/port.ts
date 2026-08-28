import { randomUUID } from 'node:crypto';

export type Channel = 'email' | 'sms';

export interface OutboundAttachment {
  /** What the recipient's mail client shows and saves it as. */
  filename: string;
  content: Buffer;
  /** Defaults to `application/octet-stream` at the provider. */
  contentType?: string;
}

/**
 * The most an email may carry.
 *
 * Providers differ — many refuse at 10 MB, most at 25, and the base64 encoding
 * an attachment travels in inflates it by a third — so the useful limit is well
 * under the smallest of them. Refusing here rather than at the provider turns
 * "the firm never received it and nobody knows why" into a failure with a
 * sentence attached.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export interface OutboundMessage {
  channel: Channel;
  /** An address or a phone number, depending on the channel. */
  to: string;
  /** Who it appears to come from. Branded as the firm, not as us. */
  from?: string;
  /** Where a reply should go — often the firm, when `from` is our domain. */
  replyTo?: string;
  subject?: string;
  text: string;
  html?: string;
  /** Carried through to the provider so a delivery receipt can be matched up. */
  reference?: string;
  /**
   * Files to attach. Email only; SMS ports ignore them.
   *
   * Bounded by `MAX_ATTACHMENT_BYTES` and refused above it rather than left for
   * the provider to bounce silently.
   */
  attachments?: OutboundAttachment[];
}

export interface SendResult {
  /** The provider's id, which is how a later delivery receipt is matched. */
  providerMessageId?: string;
  /**
   * What it cost, where the provider says.
   *
   * Present because SMS is metered per segment and the credit ledger has to be
   * debited by what was actually charged rather than by an estimate.
   */
  segments?: number;
  acceptedAt: Date;
}

/**
 * Somewhere to send a message.
 *
 * A port because both channels are vendor decisions that will change: SMS
 * pricing in Central Europe moves, and a customer will eventually require their
 * own sending domain or their own vendor. What the port must expose is fixed by
 * behaviour rather than by any one vendor's API — the sender identity, because
 * alphanumeric sender IDs are permitted in some markets and not others and that
 * decides whether a client can reply; and the segment count, because that is
 * what the ledger is debited by.
 *
 * Providers are Phase 5. This exists now so the seam is in place, and so the
 * one thing that needs sending sooner has somewhere to send it.
 */
export interface MessagePort {
  readonly channel: Channel;
  send(message: OutboundMessage): Promise<SendResult>;
}

/**
 * A port that accepts everything and sends nothing.
 *
 * For development, and for the phase where the seam exists before the vendor is
 * chosen. Unlike the file scanner's default, permissive is the right posture
 * here: not sending an email is a visible nuisance, while not scanning a file
 * is invisible and dangerous.
 */
export class NoopMessagePort implements MessagePort {
  readonly sent: OutboundMessage[] = [];

  constructor(readonly channel: Channel = 'email') {}

  async send(message: OutboundMessage): Promise<SendResult> {
    this.sent.push(message);

    /**
     * Unique across processes, not merely within one.
     *
     * The message log has a unique index on `(direction, provider_message_id)`,
     * so a counter starting at one means the second test run against the same
     * database collides — and `CommsService` reports that as a message the
     * provider refused, which is a failure in whatever was being tested rather
     * than in the double.
     */
    return { acceptedAt: new Date(), providerMessageId: `noop-${randomUUID()}` };
  }
}
