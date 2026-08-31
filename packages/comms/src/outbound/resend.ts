import { Resend } from 'resend';
import {
  MAX_ATTACHMENT_BYTES,
  type MessagePort,
  type OutboundMessage,
  type SendResult,
} from './port';

export interface ResendMessagePortOptions {
  /** The API key. Sending scope is enough; receiving needs its own. */
  apiKey: string;
  /**
   * The default sender, on a domain verified with Resend.
   *
   * Providers will not send from a domain they cannot sign for, so this is
   * ours rather than the customer's — a message is branded by putting the
   * customer's name in the display part and their address in `replyTo`, which
   * is what makes a reply reach them rather than a mailbox nobody reads.
   */
  from: string;
  /** Overridable so tests run against a local server rather than Resend. */
  baseUrl?: string;
  /**
   * How long to wait.
   *
   * Ten seconds: something is usually waiting on this — a professional who has
   * just pressed send — and the SDK sets no timeout of its own, so without one
   * a provider having a bad minute holds an HTTP response open until the socket
   * gives up.
   */
  timeoutMs?: number;
  /** An already-built client, for tests and for a deployment that shares one. */
  client?: Resend;
}

/**
 * Email through Resend.
 *
 * The provider chosen in dossier's PLAN.md §12 D-2, behind the same port as
 * every other: what the port exposes is fixed by behaviour rather than by
 * Resend's API, so replacing it is a different class here and a line of
 * configuration in the service.
 *
 * Built on the vendor's own SDK, which is the house rule — `@birtalanrobert/files`
 * takes `@aws-sdk/client-s3` the same way. It is not only less code: the
 * request and response shapes come with types that are correct by construction,
 * and the first draft of this file, written against the published REST
 * documentation, had the download field of a received message under the wrong
 * name.
 *
 * **Throws on refusal rather than returning a failure.** `CommsService` catches
 * it and records the provider's own sentence in the message log, which is what
 * support reads — a port that swallowed the reason would leave "it did not
 * send" and nothing else.
 */
export class ResendMessagePort implements MessagePort {
  readonly channel = 'email' as const;

  private readonly resend: Resend;
  private readonly timeoutMs: number;

  constructor(private readonly options: ResendMessagePortOptions) {
    this.resend =
      options.client ??
      new Resend(options.apiKey, options.baseUrl ? { baseUrl: options.baseUrl } : {});
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (message.channel !== 'email') {
      throw new Error(`Resend sends email, not ${message.channel}.`);
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

    const { data, error } = await this.within(
      this.resend.emails.send({
        from: message.from ?? this.options.from,
        to: [message.to],
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
         * Resend echoes headers back on the delivery webhook, which is how a
         * receipt is matched to the message that caused it without keeping a
         * second table of correlations.
         */
        ...(message.reference ? { headers: { 'X-Entity-Ref-ID': message.reference } } : {}),
      }),
    );

    if (error || !data?.id) {
      // The provider's own words, and never the key: this string is stored in
      // the message log and read by support.
      throw new Error(`Resend refused the message${error ? `: ${error.message}` : '.'}`);
    }

    return { providerMessageId: data.id, acceptedAt: new Date() };
  }

  /**
   * Frees the caller when the provider does not answer.
   *
   * The request itself keeps running — there is no signal to cancel it with —
   * but the message is recorded as failed and whoever was waiting stops
   * waiting, which is the part that matters to a professional watching a
   * spinner.
   */
  private async within<T>(work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;

    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Resend did not answer within ${this.timeoutMs}ms.`)),
            this.timeoutMs,
          );
        }),
      ]);
    } finally {
      // Otherwise the timer holds the process open for its full duration, which
      // in a script that sends one message and exits is a ten-second hang.
      if (timer) clearTimeout(timer);
    }
  }
}
