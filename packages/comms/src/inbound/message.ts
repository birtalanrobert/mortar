export interface InboundAttachment {
  /** What the sender called it. Never used as a storage key. */
  filename: string;
  contentType: string;
  content: Buffer;
  /** Set for images referenced from the HTML body rather than attached. */
  contentId?: string;
  inline: boolean;
}

export interface InboundMessage {
  /** The provider's id for this delivery, used to recognise a redelivery. */
  providerMessageId?: string;
  /** The `Message-ID` header, which survives forwarding. */
  messageId?: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  html?: string;
  attachments: InboundAttachment[];
  receivedAt: Date;
  /**
   * Whether the sending domain authorised this message.
   *
   * Reported rather than enforced, because the right response differs by
   * caller: a document forwarded by a client whose employer's mail server
   * mangles SPF is still a document worth having, while an instruction to
   * change where money goes is not.
   */
  authentication?: {
    spf?: 'pass' | 'fail' | 'softfail' | 'neutral' | 'none';
    dkim?: 'pass' | 'fail' | 'none';
    dmarc?: 'pass' | 'fail' | 'none';
  };
}

/**
 * Turns whatever a provider sends into an `InboundMessage`.
 *
 * The port the plan asks for, defined before the provider is chosen. Every
 * candidate — Resend, Postmark, Cloudflare Email Routing — offers either parsed
 * JSON in its own shape or the raw message; an adapter is a function from one
 * of those to this, and choosing differently later is a new adapter rather than
 * a change to anything that consumes mail.
 */
export interface InboundParser<Payload = unknown> {
  parse(payload: Payload): Promise<InboundMessage> | InboundMessage;
}
