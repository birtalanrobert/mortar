import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { CLOSE_SUPERSEDED } from '../../close-codes';
import type { RealtimePublisher } from '../../server/publisher';
import type { BacklogPort } from '../../server/backlog';
import { resume } from '../../server/resume';
import { parseFrame, type ClientFrame, type RealtimeEvent, type ServerFrame } from '../../wire';

/**
 * Who is asking, and what they may listen to.
 *
 * **Authorisation is the product's**, always. This package knows what a channel
 * is and nothing about who owns one — a venue's station, a guild's chat and a
 * table's tab are the same shape here and completely different questions there.
 * Returning a subset rather than a boolean lets a product grant part of a
 * request: a display asking for two stations it may see and one it may not gets
 * the two, rather than a connection that fails for a reason nobody can see.
 */
export type Authorise = (
  request: IncomingMessage,
  channels: readonly string[],
) => Promise<readonly string[]> | readonly string[];

/**
 * Whether a connection is opened at all, asked once, before the upgrade.
 *
 * `authorise` decides what a connection may hear; this decides whether there is
 * a connection. Without it a caller with no credential at all is upgraded,
 * granted nothing, and kept alive by the heartbeat for as long as it answers —
 * a socket, a file descriptor and a place in every fan-out, held for free by
 * anybody who can reach the port. It is also where a product checks `Origin`:
 * a browser sends its cookies on a WebSocket upgrade from any page, so a
 * gateway that authenticates by cookie must refuse a page it does not serve.
 *
 * Admitting with a `key` — the account the connection is a person's — is what
 * `maxConnectionsPerKey` counts by. A refusal thrown with an HTTP `status` of
 * 400 to 599, a rate limit's 429 among them, is answered with it, and with its
 * `retryAfter` in seconds as `Retry-After`; any other throw is a check that
 * could not be made.
 */
export type Admit = (request: IncomingMessage) => Promise<Admitted> | Admitted;

/** What `admit` answers: refused, admitted, or admitted under a key the cap counts. */
export type Admitted = boolean | { readonly key: string };

export interface SocketServerOptions {
  readonly publisher: RealtimePublisher;
  readonly backlog: BacklogPort;
  readonly authorise: Authorise;
  /**
   * Asked before the upgrade. A refusal is answered `403 Forbidden` — the
   * status RFC 6455 names for a handshake the server will not accept — and a
   * throw `503 Service Unavailable`, since a check that could not be made is
   * not a caller refused. Absent, every upgrade on the path is accepted.
   */
  readonly admit?: Admit;
  /** Where the upgrade happens. One path, so a proxy can route it. */
  readonly path?: string;
  /**
   * The most connections one key — the account `admit` named — holds on this
   * process at once. Past it the oldest is closed with `CLOSE_SUPERSEDED`, so a
   * page just opened always has its socket, and the page given way polls.
   * Counted on each process, never across them: a product that runs several
   * gives one person at most this many on each. Absent, and for a connection
   * admitted with no key, connections are not counted.
   */
  readonly maxConnectionsPerKey?: number;
  /** How often the server proves a connection is alive. */
  readonly heartbeatMs?: number;
  /**
   * The largest frame a client may send, in bytes; a larger one closes the
   * connection with 1009. Default 64 KiB.
   */
  readonly maxPayload?: number;
  /**
   * Told about what the server could not do: an `admit` that threw, or a
   * subscription it could not answer because `authorise` or the backlog
   * failed. Where a product logs, since nothing here can.
   */
  readonly onError?: (error: unknown) => void;
}

/**
 * What a client frame may weigh unless the product says otherwise.
 *
 * `ws`'s own default is 100 MiB, which lets any connection make the process
 * buffer and parse a hundred megabytes of JSON. The largest frame a client
 * sends is a subscription, and one naming a few hundred channels with where it
 * stands in each is a few kilobytes.
 */
const DEFAULT_MAX_PAYLOAD = 64 * 1024;

/** The close code for "the server met a condition it could not answer". */
const INTERNAL_ERROR = 1011;

interface Connection {
  readonly socket: WebSocket;
  readonly channels: Set<string>;
  /** The key `admit` named, or none. */
  readonly key: string | null;
  alive: boolean;
}

/** An error's HTTP status, when it carries one a refusal can be answered with. */
function refusalStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599
    ? status
    : null;
}

/** The `Retry-After` a refusal names, in whole seconds, or none. */
function retryAfterOf(error: unknown): Record<string, string> {
  const retryAfter = (error as { retryAfter?: unknown } | null)?.retryAfter;
  return typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0
    ? { 'Retry-After': String(Math.ceil(retryAfter)) }
    : {};
}

/**
 * The socket half: connections, subscriptions and resume.
 *
 * It holds no state worth losing. Every connection is a set of channel names
 * and a socket; everything a client could need again is in the backlog, which
 * is why a gateway process can be replaced mid-service and the kitchen sees a
 * reconnection rather than a gap.
 *
 * The frames it answers are the same ones the polling fallback answers over
 * HTTP, through the same `resume` — which is what stops the fallback from being
 * a second protocol that behaves differently on the day it is needed.
 */
export class RealtimeSocketServer {
  private readonly connections = new Map<WebSocket, Connection>();
  /** Each key's connections, the oldest first — the order the cap gives way in. */
  private readonly byKey = new Map<string, Connection[]>();
  /** The key each admitted upgrade was given, until its connection is accepted. */
  private readonly keys = new WeakMap<IncomingMessage, string>();
  private server: WebSocketServer | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly options: SocketServerOptions) {}

  /** Attaches to the HTTP server the application already listens on. */
  attach(http: HttpServer): void {
    const admit = this.options.admit;

    this.server = new WebSocketServer({
      server: http,
      path: this.options.path ?? '/realtime',
      maxPayload: this.options.maxPayload ?? DEFAULT_MAX_PAYLOAD,
      /*
       * `verifyClient` rather than an `upgrade` listener of our own, because
       * `ws` asks it only after it has validated the handshake and matched the
       * path — so `admit` is never asked about a request that is not a
       * WebSocket upgrade to this gateway — and it answers the refusal itself.
       * The two-argument form is the asynchronous one.
       */
      ...(admit
        ? {
            verifyClient: (
              info: { req: IncomingMessage },
              done: (
                admitted: boolean,
                status?: number,
                message?: string,
                headers?: Record<string, string>,
              ) => void,
            ) => this.verify(admit, info.req, done),
          }
        : {}),
    });

    this.server.on('connection', (socket, request) => this.accept(socket, request));
    /*
     * `ws` passes on every error of the HTTP server it is attached to — a port
     * already taken, as the server starts to listen — and an error emitted
     * with nobody listening ends the process. The server's owner is told of it
     * already, its `listen` failing with it; here it is nobody's to report.
     */
    this.server.on('error', () => undefined);

    /*
     * One subscription to the publisher for the whole process, rather than one
     * per socket. Forty displays in a busy venue would otherwise mean forty
     * listeners walked on every event, to deliver to at most forty — the same
     * work, done forty times.
     */
    this.unsubscribe = this.options.publisher.onEvent((event) => this.fanOut(event));

    const every = this.options.heartbeatMs ?? 15_000;

    this.heartbeat = setInterval(() => {
      for (const [socket, connection] of this.connections) {
        /*
         * A socket that did not answer the last round is gone, whatever TCP
         * believes. §5.10: a display receiving nothing looks exactly like a
         * kitchen with no orders, and this is the server's half of telling
         * them apart.
         */
        if (!connection.alive) {
          socket.terminate();
          this.forget(connection);
          continue;
        }

        connection.alive = false;
        socket.ping();
      }
    }, every);
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.unsubscribe?.();
    this.unsubscribe = null;

    for (const socket of this.connections.keys()) socket.close();
    this.connections.clear();
    this.byKey.clear();

    await new Promise<void>((done) => {
      if (!this.server) return done();
      this.server.close(() => done());
    });
    this.server = null;
  }

  /** How many connections this process holds. For a health endpoint. */
  get connectionCount(): number {
    return this.connections.size;
  }

  private accept(socket: WebSocket, request: IncomingMessage): void {
    const key = this.keys.get(request) ?? null;
    const connection: Connection = { socket, channels: new Set(), key, alive: true };
    this.connections.set(socket, connection);
    this.count(connection);

    socket.on('pong', () => {
      connection.alive = true;
    });

    socket.on('close', () => this.forget(connection));
    socket.on('error', () => socket.terminate());

    socket.on('message', (raw) => {
      const frame = parseFrame<ClientFrame>(String(raw));
      if (!frame) return;

      this.handle(connection, request, frame).catch((error: unknown) => {
        this.report(error);
        /*
         * Closed rather than carried on. An `authorise` or a backlog that threw
         * part-way through a subscription leaves the connection holding some of
         * its channels with no welcome, and a client that believes it is
         * subscribed to a channel it is not is quietly incomplete. Closing sends
         * it to polling and back, resuming from where it stood, so nothing is
         * lost. Before this, the rejection escaped the message handler: an
         * unhandled rejection, which takes a Node process down by default — a
         * database blip in `authorise` stopping every connection on the replica.
         */
        connection.socket.close(INTERNAL_ERROR);
      });
    });
  }

  /**
   * A connection counted under its key, and the oldest of the key's closed
   * while there are more than the cap — closed, and forgotten at once, so the
   * count is right before its `close` event comes.
   */
  private count(connection: Connection): void {
    const max = this.options.maxConnectionsPerKey;
    if (connection.key === null || max === undefined) return;
    const held = this.byKey.get(connection.key) ?? [];
    held.push(connection);
    this.byKey.set(connection.key, held);
    while (held.length > max) {
      const oldest = held[0]!;
      this.forget(oldest);
      oldest.socket.close(CLOSE_SUPERSEDED, 'superseded');
    }
  }

  /** A connection gone: out of the connections, and out of its key's count. */
  private forget(connection: Connection): void {
    this.connections.delete(connection.socket);
    if (connection.key === null) return;
    const held = this.byKey.get(connection.key);
    if (!held) return;
    const index = held.indexOf(connection);
    if (index !== -1) held.splice(index, 1);
    if (held.length === 0) this.byKey.delete(connection.key);
  }

  private verify(
    admit: Admit,
    request: IncomingMessage,
    done: (
      admitted: boolean,
      status?: number,
      message?: string,
      headers?: Record<string, string>,
    ) => void,
  ): void {
    Promise.resolve()
      .then(() => admit(request))
      .then(
        (admitted) => {
          if (!admitted) return done(false, 403);
          if (typeof admitted === 'object') this.keys.set(request, admitted.key);
          done(true);
        },
        (error: unknown) => {
          this.report(error);
          const status = refusalStatus(error);
          if (status === null) return done(false, 503);
          done(false, status, undefined, retryAfterOf(error));
        },
      )
      .catch((error: unknown) => this.report(error));
  }

  private report(error: unknown): void {
    try {
      this.options.onError?.(error);
    } catch {
      // A reporter that throws must not become the unhandled rejection it
      // was given to report.
    }
  }

  private async handle(
    connection: Connection,
    request: IncomingMessage,
    frame: ClientFrame,
  ): Promise<void> {
    switch (frame.kind) {
      case 'ping':
        this.send(connection.socket, { kind: 'pong', at: frame.at });
        return;

      case 'unsubscribe':
        for (const channel of frame.channels) connection.channels.delete(channel);
        return;

      case 'subscribe': {
        const allowed = await this.options.authorise(request, frame.channels);
        for (const channel of allowed) connection.channels.add(channel);

        const standing: Record<string, number> = {};

        for (const channel of allowed) {
          // Absent is no position, which is not the same as a position of 0.
          const answer = await resume(this.options.backlog, channel, frame.since?.[channel]);

          standing[channel] = answer.latest;

          if (answer.gap) {
            this.send(connection.socket, answer.gap);
            continue;
          }

          /*
           * The replay goes **before** the welcome, deliberately.
           *
           * A client applies events in the order they arrive, and the welcome
           * is what tells it where a channel stands. Sending the welcome first
           * would let a client that has nothing in a channel adopt the latest
           * sequence and then reject the replay it is about to receive as
           * already seen.
           */
          for (const event of answer.events) {
            this.send(connection.socket, { kind: 'event', event });
          }
        }

        this.send(connection.socket, { kind: 'welcome', channels: standing });
        return;
      }
    }
  }

  private fanOut(event: RealtimeEvent): void {
    for (const connection of this.connections.values()) {
      if (!connection.channels.has(event.channel)) continue;

      this.send(connection.socket, { kind: 'event', event });
    }
  }

  private send(socket: WebSocket, frame: ServerFrame): void {
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      /*
       * A socket that died between the check and the write. Its `close` handler
       * is already on its way and owns the cleanup — and one screen's dead
       * connection must not stop the kitchen's other three from being told.
       */
    }
  }
}
