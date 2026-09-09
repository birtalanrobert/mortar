/**
 * The frames that cross the connection, and nothing else.
 *
 * Framework-free and dependency-free on purpose: four browser bundles and two
 * servers import this, and a wire format that could only be described by one of
 * them is a wire format the other five will describe slightly differently.
 *
 * **Every event carries the channel it belongs to and its sequence number in
 * that channel.** That pair is what makes a gap detectable, and gap detection
 * is the whole reason this package exists rather than a socket and some hope:
 * a client that can say "I last saw 412" and be told what it missed is the
 * difference between *probably fine* and *provably complete*.
 */

/** One thing that happened, as it is delivered. */
export interface RealtimeEvent<T = unknown> {
  readonly channel: string;
  /**
   * Monotonic within the channel, starting at 1. Never reused, never reordered.
   *
   * Per channel rather than global, because a global counter would make every
   * subscriber's gap detection depend on traffic they cannot see — a kitchen
   * display would think it had missed the messages a guest's phone received.
   */
  readonly seq: number;
  /** What kind of thing it is. The product's vocabulary, not this package's. */
  readonly type: string;
  readonly data: T;
  /** Milliseconds since the epoch, from the publisher's clock. */
  readonly at: number;
}

/** What a client sends. */
export type ClientFrame =
  | {
      readonly kind: 'subscribe';
      readonly channels: readonly string[];
      /**
       * What the client last saw in each channel, so the server can send what
       * it missed. Absent for a channel means "everything from now" — a new
       * screen does not want yesterday's tickets.
       */
      readonly since?: Readonly<Record<string, number>>;
    }
  | { readonly kind: 'unsubscribe'; readonly channels: readonly string[] }
  /**
   * The client's half of the heartbeat.
   *
   * Both directions, and that is not redundancy: a TCP connection can be open
   * in one direction and dead in the other for minutes, and a display that is
   * receiving nothing looks exactly like a kitchen with no orders.
   */
  | { readonly kind: 'ping'; readonly at: number };

/** What the server sends. */
export type ServerFrame =
  | {
      readonly kind: 'welcome';
      /** Where each channel stands now, so a client knows what it is joining. */
      readonly channels: Readonly<Record<string, number>>;
    }
  | { readonly kind: 'event'; readonly event: RealtimeEvent }
  | {
      /**
       * The server cannot replay that far back.
       *
       * Said out loud rather than pretended away: the backlog is bounded, and a
       * client that was away longer than it must reload rather than carry on
       * believing it is complete. A silent partial replay is the failure this
       * package is built to prevent.
       */
      readonly kind: 'gap';
      readonly channel: string;
      /** The oldest sequence still available. Everything before it is lost. */
      readonly from: number;
    }
  | { readonly kind: 'pong'; readonly at: number };

/** Parses a frame, returning nothing rather than throwing on rubbish. */
export function parseFrame<T extends ClientFrame | ServerFrame>(raw: string): T | null {
  try {
    const value = JSON.parse(raw) as unknown;

    /*
     * A shape check rather than a schema library. This runs on every message on
     * every connection, and the only thing the transport needs to know is
     * whether it can dispatch — everything past `kind` is the product's to
     * validate, in the language it understands.
     */
    if (typeof value !== 'object' || value === null) return null;
    if (typeof (value as { kind?: unknown }).kind !== 'string') return null;

    return value as T;
  } catch {
    return null;
  }
}
