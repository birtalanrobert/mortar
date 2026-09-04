import { createTransport, type SMTPSentMessageInfo, type Transporter } from 'nodemailer';
import {
  MAX_ATTACHMENT_BYTES,
  type MessagePort,
  type OutboundMessage,
  type SendResult,
} from './port';

export interface SmtpMessagePortOptions {
  /**
   * The server, as a URL — `smtp://localhost:3014`, `smtps://user:pass@host`.
   *
   * One string rather than five options because that is how a mail server is
   * given to you, and splitting it into host, port, secure, user and password
   * moves five chances to get it wrong into the environment file.
   */
  url: string;
  /**
   * The default sender.
   *
   * A relay will refuse a `from` it is not authorised for, so this belongs to
   * whoever operates the server. A message is branded by putting the customer's
   * name in the display part and their address in `replyTo`, which is what
   * makes a reply reach them rather than a mailbox nobody reads.
   */
  from: string;
  /**
   * How long to wait, at each stage.
   *
   * Ten seconds: something is usually waiting on this — somebody who has just
   * pressed send — and SMTP's own failure mode is a connection that opens and
   * then says nothing, which without a timeout holds an HTTP response open
   * until the socket gives up.
   */
  timeoutMs?: number;
  /**
   * Accept a certificate the system does not trust.
   *
   * **False by default, and it must stay false against anything public.** With
   * it off, a server offering STARTTLS with a self-signed or expired
   * certificate is refused — which is the whole point of the upgrade, because a
   * certificate nobody checks makes STARTTLS an encrypted conversation with
   * whoever answered.
   *
   * It exists because two legitimate cases cannot satisfy that: a mail catcher
   * on a developer's machine, and a relay inside a network that signs its own
   * certificates. Both are named deployments rather than defaults.
   */
  allowSelfSignedCertificate?: boolean;
  /**
   * An already-built transport, for tests and for a deployment that shares one.
   *
   * Typed by what an SMTP transport actually resolves with: nodemailer's
   * default `SentMessageInfo` is `void`, so a bare `Transporter` hides both the
   * message id and the rejected-recipient list this port depends on.
   */
  transport?: Transporter<SMTPSentMessageInfo>;
}

/**
 * Email over SMTP.
 *
 * The transport every local stack already has somewhere to point at: each
 * project's Compose file runs Mailpit, and until this existed nothing could
 * reach it — so an invitation, a receipt or a password reset could not be
 * followed end to end on a developer's machine without a vendor account.
 *
 * It is not only a development seam. A customer with their own mail server, a
 * provider offering an SMTP relay rather than an API, and a deployment in a
 * jurisdiction where mail may not leave the building are all ordinary, and all
 * of them are this class with a different URL.
 *
 * Built on nodemailer, which is the house rule — the vendor's own client where
 * there is one, and for SMTP the protocol's own long-standing implementation
 * rather than a socket and a state machine written here.
 *
 * **Throws on refusal rather than returning a failure.** `CommsService` catches
 * it and records the server's own sentence in the message log, which is what
 * support reads — a port that swallowed the reason would leave "it did not
 * send" and nothing else.
 */
export class SmtpMessagePort implements MessagePort {
  readonly channel = 'email' as const;

  private readonly transport: Transporter<SMTPSentMessageInfo>;

  constructor(private readonly options: SmtpMessagePortOptions) {
    const timeout = options.timeoutMs ?? 10_000;

    this.transport =
      options.transport ??
      createTransport({
        url: options.url,
        /*
         * All three, because they fail at different moments.
         *
         * `connection` covers a host that does not answer, `greeting` a server
         * that accepts the socket and never speaks — the shape a misconfigured
         * container most often takes — and `socket` a conversation that stalls
         * mid-message. Setting only the first leaves the other two unbounded.
         */
        connectionTimeout: timeout,
        greetingTimeout: timeout,
        socketTimeout: timeout,
        ...(options.allowSelfSignedCertificate ? { tls: { rejectUnauthorized: false } } : {}),
      });
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (message.channel !== 'email') {
      throw new Error(`SMTP sends email, not ${message.channel}.`);
    }

    /**
     * Bounded again here, not only in `CommsService`.
     *
     * The service refuses an oversized attachment before any port sees it, and
     * a port used directly — a script, a test, the next consumer — has no such
     * guard. Duplicating one comparison is cheaper than the failure it
     * prevents, which is a silent late bounce.
     */
    const attached = (message.attachments ?? []).reduce(
      (total, file) => total + file.content.length,
      0,
    );
    if (attached > MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `Attachments total ${Math.round(attached / 1024 / 1024)} MB, over the limit.`,
      );
    }

    let accepted: SMTPSentMessageInfo;

    try {
      accepted = await this.transport.sendMail({
        from: message.from ?? this.options.from,
        to: message.to,
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        subject: message.subject ?? '',
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
        ...(message.attachments?.length
          ? {
              attachments: message.attachments.map((file) => ({
                filename: file.filename,
                content: file.content,
                ...(file.contentType ? { contentType: file.contentType } : {}),
              })),
            }
          : {}),
        /**
         * Our own reference travels in a header.
         *
         * The same header the Resend port uses, so a receipt is matched the
         * same way whichever transport sent it — and a server that returns a
         * bounce quotes the original headers back, which is where support
         * looks.
         */
        ...(message.reference ? { headers: { 'X-Entity-Ref-ID': message.reference } } : {}),
      });
    } catch (error) {
      // The server's own words, and never the URL — which carries a password.
      // This string is stored in the message log and read by support.
      throw new Error(`SMTP refused the message: ${(error as Error).message}`, { cause: error });
    }

    /*
     * A server can accept the conversation and reject the recipient.
     *
     * `sendMail` resolves in that case, with the address listed under
     * `rejected`. Treating that as a success writes "delivered" against a
     * message the server explicitly refused, which is the exact failure the
     * message log exists to prevent.
     */
    if (accepted.rejected.length > 0) {
      throw new Error(`SMTP rejected ${accepted.rejected.length} recipient(s).`);
    }

    return { providerMessageId: accepted.messageId, acceptedAt: new Date() };
  }

  /**
   * Closes any connection the transport is holding.
   *
   * A pooled transport keeps sockets open, and a script that sends one message
   * and exits otherwise hangs until they time out. Harmless to call on an
   * unpooled one.
   */
  close(): void {
    this.transport.close();
  }
}
