import { Resend } from 'resend';

export interface ResendInboundOptions {
  /** An API key with access to the receiving endpoints. */
  apiKey: string;
  /** The endpoint's signing secret, as the dashboard gives it: `whsec_…`. */
  webhookSecret?: string;
  baseUrl?: string;
  client?: Resend;
}

export interface VerifiedEvent {
  type?: string;
  data?: { email_id?: string };
}

/**
 * The provider's side of receiving mail.
 *
 * Two jobs, and they are separate on purpose. Verifying that a webhook really
 * came from Resend is the security boundary of an unauthenticated public
 * endpoint; fetching the message it names is ordinary work that happens
 * afterwards.
 *
 * **The webhook carries metadata and no body.** It names an email; the original
 * has to be fetched. That is a sensible thing for a provider to do with a
 * multi-megabyte message and an awkward shape to receive, and it is why this
 * class exists rather than a `parse(body)` function.
 *
 * `rawMime` returns the **original**, not the provider's parsed fields, so
 * `parseMime` stays ours and the day this vendor is replaced nothing above it
 * moves.
 */
export class ResendInbound {
  private readonly resend: Resend;

  constructor(private readonly options: ResendInboundOptions) {
    this.resend =
      options.client ??
      new Resend(options.apiKey, options.baseUrl ? { baseUrl: options.baseUrl } : {});
  }

  /**
   * Whether this request really came from the provider, and what it says.
   *
   * Returns `undefined` rather than throwing on a bad signature: the caller's
   * correct response is one unauthenticated answer for every failure, and a
   * thrown error tempts a route into reporting *which* check failed.
   *
   * `payload` must be the bytes that arrived. A parsed object re-serialised has
   * different whitespace and key order, and the signature is over bytes — so
   * the route has to keep the raw body.
   *
   * Verification is the vendor's own (Standard Webhooks), which is worth more
   * than the fifteen lines it replaces: it is their scheme, it moves when they
   * move it, and several signatures are accepted so a secret can be rotated
   * without an outage.
   */
  verify(payload: string | Buffer, headers: Record<string, string | string[] | undefined>) {
    if (!this.options.webhookSecret) return undefined;

    const id = one(headers, 'svix-id');
    const timestamp = one(headers, 'svix-timestamp');
    const signature = one(headers, 'svix-signature');
    if (!id || !timestamp || !signature) return undefined;

    try {
      return this.resend.webhooks.verify({
        payload: typeof payload === 'string' ? payload : payload.toString('utf8'),
        headers: { id, timestamp, signature },
        webhookSecret: this.options.webhookSecret,
      }) as VerifiedEvent;
    } catch {
      return undefined;
    }
  }

  /** The email id an `email.received` event names, or undefined if it is not one. */
  static emailIdOf(event: unknown): string | undefined {
    const received = event as VerifiedEvent | undefined;
    if (received?.type !== 'email.received') return undefined;
    return received.data?.email_id;
  }

  async rawMime(emailId: string): Promise<string> {
    const { data, error } = await this.resend.emails.receiving.get(emailId);

    if (error || !data) {
      throw new Error(
        `Resend would not return message ${emailId}${error ? `: ${error.message}` : '.'}`,
      );
    }

    const url = data.raw?.download_url;
    if (!url) throw new Error(`Resend returned no original for message ${emailId}.`);

    // The signed URL carries its own authorisation. Sending the API key to a
    // file host would be a second place it can leak from.
    const original = await fetch(url);
    if (!original.ok) {
      throw new Error(`The original of message ${emailId} could not be read (${original.status}).`);
    }

    return original.text();
  }
}

/**
 * One header value, whatever the framework made of it.
 *
 * Express gives an object whose values are sometimes arrays and whose casing
 * follows the wire. Reading them here keeps that detail out of every route that
 * receives a webhook.
 */
function one(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name] ?? headers[name.toUpperCase()];
  return Array.isArray(value) ? value[0] : value;
}
