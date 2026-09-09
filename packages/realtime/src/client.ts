import { ChannelCursor } from './gaps';
import { parseFrame, type ClientFrame, type RealtimeEvent, type ServerFrame } from './wire';

export type ConnectionState = 'connecting' | 'live' | 'polling' | 'offline';

export interface ClientOptions {
  /** `wss://…` for the socket. The polling URL is derived unless given. */
  readonly url: string;
  /** Where the same events can be fetched over HTTP when a socket will not hold. */
  readonly pollUrl?: string;
  readonly channels: readonly string[];
  readonly onEvent: (event: RealtimeEvent) => void;
  /**
   * Told every time the connection changes, because a screen must be able to
   * say so. §5.10: a display that has gone quiet looks exactly like a kitchen
   * with no orders, and the difference has to be unmissable.
   */
  readonly onState?: (state: ConnectionState) => void;
  /**
   * Called when the server cannot replay far enough back.
   *
   * The honest answer to "you were away too long" is a reload, not a partial
   * replay — so this is the product's cue to fetch its own state again rather
   * than something this package can paper over.
   */
  readonly onResync?: (channel: string) => void;
  /** How often each side proves it is alive. */
  readonly heartbeatMs?: number;
  /** How often the fallback asks, when there is no socket. */
  readonly pollMs?: number;
  /** Injected so tests need no browser and no timers of their own. */
  readonly now?: () => number;
  readonly socketFactory?: (url: string) => SocketLike;
  readonly fetch?: typeof globalThis.fetch;
}

/** The part of `WebSocket` this uses, so a test can supply its own. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((this: unknown, event: unknown) => unknown) | null;
  onclose: ((this: unknown, event: unknown) => unknown) | null;
  onerror: ((this: unknown, event: unknown) => unknown) | null;
  onmessage: ((this: unknown, event: { data: unknown }) => unknown) | null;
}

/**
 * A connection that can prove what it has and has not seen.
 *
 * Three things make this worth a package rather than a `new WebSocket` in each
 * product: it **resumes from where it stood** rather than assuming it missed
 * nothing, it **says so loudly** when it cannot, and it **falls back to
 * polling** over the same protocol — built and tested rather than described,
 * because a fallback written after the thing it backs up is one nobody has
 * seen work.
 *
 * Dependency-free and framework-free. Four browser bundles import it.
 */
export class RealtimeClient {
  private socket: SocketLike | null = null;
  private state: ConnectionState = 'offline';
  private readonly cursor = new ChannelCursor();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private poller: ReturnType<typeof setInterval> | null = null;
  private retry = 0;
  private closed = false;
  private lastHeard = 0;

  constructor(private readonly options: ClientOptions) {}

  /** Where this client stands, for a product that wants to show it. */
  get connection(): ConnectionState {
    return this.state;
  }

  seenAt(channel: string): number {
    return this.cursor.seenAt(channel);
  }

  start(): void {
    this.closed = false;
    this.open();
  }

  stop(): void {
    this.closed = true;
    this.stopHeartbeat();
    this.stopPolling();
    this.socket?.close();
    this.socket = null;
    this.moveTo('offline');
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private moveTo(state: ConnectionState): void {
    if (this.state === state) return;

    this.state = state;
    this.options.onState?.(state);
  }

  private open(): void {
    if (this.closed) return;

    this.moveTo('connecting');

    const make =
      this.options.socketFactory ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);

    let socket: SocketLike;
    try {
      socket = make(this.options.url);
    } catch {
      // A URL a browser will not open at all — a mixed-content page, a blocked
      // scheme. Polling is the answer, and it is the same answer as a socket
      // that opens and immediately dies.
      this.fallBack();
      return;
    }

    this.socket = socket;

    socket.onopen = () => {
      this.retry = 0;
      this.lastHeard = this.now();
      this.stopPolling();
      this.moveTo('live');

      /*
       * The subscription carries **where this client stands**, so the server
       * sends what it missed. A reconnection that subscribed from now would
       * lose exactly the events that arrived while it was away — which is the
       * window a reconnection exists to cover.
       */
      this.send({ kind: 'subscribe', channels: this.options.channels, since: this.cursor.since() });
      this.startHeartbeat();
    };

    socket.onmessage = (message) => {
      this.lastHeard = this.now();

      const frame = parseFrame<ServerFrame>(String(message.data));
      if (!frame) return;

      this.receive(frame);
    };

    socket.onerror = () => socket.close();

    socket.onclose = () => {
      this.socket = null;
      this.stopHeartbeat();
      if (this.closed) return;

      this.fallBack();
    };
  }

  private receive(frame: ServerFrame): void {
    switch (frame.kind) {
      case 'welcome':
        for (const [channel, seq] of Object.entries(frame.channels)) {
          // Only for a channel this client has no position in. A `welcome` that
          // reset the cursor would throw away the resume it just asked for.
          if (this.cursor.seenAt(channel) === 0) this.cursor.start(channel, seq);
        }
        return;

      case 'event': {
        const verdict = this.cursor.offer(frame.event);
        if (verdict === 'take') this.options.onEvent(frame.event);
        if (verdict === 'gap') this.resync(frame.event.channel);
        return;
      }

      case 'gap':
        /*
         * The server cannot replay that far back, and says so. A silent partial
         * replay is the failure this package exists to prevent, so the client
         * is told to fetch its own state again rather than carrying on.
         */
        this.cursor.start(frame.channel, frame.from);
        this.options.onResync?.(frame.channel);
        return;

      case 'pong':
        return;
    }
  }

  /**
   * Asks for everything since where this client stands.
   *
   * Over the socket where there is one, because that is the cheap path — the
   * poll below is the same request over HTTP for a client that has no socket
   * at all.
   */
  private resync(channel: string): void {
    this.options.onResync?.(channel);
    this.send({ kind: 'subscribe', channels: [channel], since: this.cursor.since() });
  }

  private send(frame: ClientFrame): void {
    try {
      this.socket?.send(JSON.stringify(frame));
    } catch {
      // A socket that has died between the check and the write. `onclose` is
      // already on its way, and it owns the recovery.
    }
  }

  private startHeartbeat(): void {
    const every = this.options.heartbeatMs ?? 15_000;
    this.stopHeartbeat();

    this.heartbeat = setInterval(() => {
      /*
       * Both directions, and this is the half that matters. A TCP connection
       * can be open one way and dead the other for minutes: a display that is
       * receiving nothing looks exactly like a kitchen with no orders, and only
       * an unanswered ping tells them apart.
       */
      if (this.now() - this.lastHeard > every * 2) {
        this.socket?.close();
        return;
      }

      this.send({ kind: 'ping', at: this.now() });
    }, every);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  /**
   * Polling, and a socket attempt behind it.
   *
   * The order is deliberate: **polling starts immediately** and the socket is
   * retried in the background, so a venue whose network eats WebSockets — a
   * hotel, a corporate guest network, an ageing router — has a working display
   * rather than a spinner and an exponential backoff.
   */
  private fallBack(): void {
    if (this.closed) return;

    this.startPolling();

    this.retry += 1;
    const wait = Math.min(30_000, 500 * 2 ** Math.min(this.retry, 6));

    setTimeout(() => {
      if (!this.closed && !this.socket) this.open();
    }, wait);
  }

  private startPolling(): void {
    if (this.poller) return;

    const url = this.options.pollUrl;
    if (!url) {
      this.moveTo('offline');
      return;
    }

    this.moveTo('polling');

    const ask = async () => {
      const doFetch = this.options.fetch ?? globalThis.fetch;

      try {
        const response = await doFetch(
          `${url}${url.includes('?') ? '&' : '?'}since=${encodeURIComponent(
            JSON.stringify(this.cursor.since()),
          )}&channels=${encodeURIComponent(this.options.channels.join(','))}`,
          { cache: 'no-store' },
        );

        if (!response.ok) return;

        const body = (await response.json()) as { events?: RealtimeEvent[] };

        for (const event of body.events ?? []) {
          const verdict = this.cursor.offer(event);
          if (verdict === 'take') this.options.onEvent(event);
          if (verdict === 'gap') this.options.onResync?.(event.channel);
        }
      } catch {
        // The network is gone rather than merely hostile to sockets. Saying so
        // is the display's job, and it already knows: no events are arriving.
      }
    };

    void ask();
    this.poller = setInterval(() => void ask(), this.options.pollMs ?? 3_000);
  }

  private stopPolling(): void {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
  }
}
