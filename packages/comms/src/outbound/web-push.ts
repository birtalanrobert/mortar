import webpush from 'web-push';
import type { Channel, MessagePort, OutboundMessage, SendResult } from './port';

/**
 * The keys a push service checks before it will accept anything.
 *
 * VAPID is a claim about *who is sending*, signed with a key pair the business
 * generates once and keeps. The public half goes to every browser at
 * subscription time; the private half never leaves the server. `subject` is a
 * `mailto:` or a URL a push service operator can reach a human at, and it is
 * required rather than decorative — a sender nobody can contact is a sender
 * they eventually block.
 */
export interface VapidKeys {
  readonly subject: string;
  readonly publicKey: string;
  readonly privateKey: string;
}

/**
 * Raised when a push service says the subscription is gone for good.
 *
 * **404 and 410 mean delete, and nothing else does.** A browser that has
 * revoked permission, or a PWA somebody uninstalled, answers this for ever —
 * and a product that keeps trying has delivery figures that are quietly
 * meaningless. Distinguished from an ordinary failure so the caller can act on
 * it rather than parse a status code out of a message.
 */
export class PushSubscriptionGone extends Error {
  constructor(readonly endpoint: string) {
    super('That push subscription no longer exists.');
    this.name = 'PushSubscriptionGone';
  }
}

export interface WebPushOptions {
  readonly vapid: VapidKeys;
  /**
   * Resolves the keys that encrypt to an endpoint.
   *
   * Supplied by `CommsService`, which owns the subscription table — so this
   * port stays a transport and knows nothing about who is subscribed.
   */
  readonly keysFor: (endpoint: string) => Promise<{ p256dh: string; auth: string } | null>;
  /** Told when a subscription is gone, so the row can go with it. */
  readonly onGone?: (endpoint: string) => Promise<void> | void;
  /** Seconds a push service should hold the message for. Four hours. */
  readonly ttlSeconds?: number;
}

/**
 * Writing to a browser that has agreed to it.
 *
 * **The payload is encrypted to the device, not to us.** The two keys the
 * browser handed over are the only way to reach it, and the push service
 * carrying the message cannot read it — which is why the subscription is stored
 * whole rather than referenced.
 *
 * The message is deliberately small. A push service will refuse a large payload
 * outright, and more to the point a notification is a *title and a sentence* on
 * a lock screen: anything longer belongs in the application the tap opens.
 */
export class WebPushMessagePort implements MessagePort {
  readonly channel: Channel = 'push';

  constructor(private readonly options: WebPushOptions) {
    webpush.setVapidDetails(
      options.vapid.subject,
      options.vapid.publicKey,
      options.vapid.privateKey,
    );
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const keys = await this.options.keysFor(message.to);

    if (!keys) {
      /*
       * An endpoint with no keys is not a delivery failure to retry.
       *
       * It is a row that has been deleted, or an address somebody typed. Thrown
       * as `Gone` so the caller treats it the same way it treats the push
       * service saying so — one answer, one behaviour.
       */
      throw new PushSubscriptionGone(message.to);
    }

    try {
      const result = await webpush.sendNotification(
        { endpoint: message.to, keys },
        JSON.stringify({
          title: message.subject ?? '',
          body: message.text,
          /*
           * Where a tap should land.
           *
           * Carried in the payload rather than in a header, because it is the
           * service worker that decides what a notification does, and it reads
           * this. A notification that opens nothing in particular is one people
           * stop tapping.
           */
          ...(message.url === undefined ? {} : { url: message.url }),
        }),
        { TTL: this.options.ttlSeconds ?? 4 * 60 * 60 },
      );

      return { acceptedAt: new Date(), providerMessageId: String(result.statusCode) };
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;

      if (status === 404 || status === 410) {
        await this.options.onGone?.(message.to);
        throw new PushSubscriptionGone(message.to);
      }

      throw error;
    }
  }
}
