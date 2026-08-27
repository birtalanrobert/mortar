export type Channel = 'email' | 'sms';

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
    return { acceptedAt: new Date(), providerMessageId: `noop-${this.sent.length}` };
  }
}
