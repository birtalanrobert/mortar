import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
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

export interface SocketServerOptions {
  readonly publisher: RealtimePublisher;
  readonly backlog: BacklogPort;
  readonly authorise: Authorise;
  /** Where the upgrade happens. One path, so a proxy can route it. */
  readonly path?: string;
  /** How often the server proves a connection is alive. */
  readonly heartbeatMs?: number;
}

interface Connection {
  readonly socket: WebSocket;
  readonly channels: Set<string>;
  alive: boolean;
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
  private server: WebSocketServer | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly options: SocketServerOptions) {}

  /** Attaches to the HTTP server the application already listens on. */
  attach(http: HttpServer): void {
    this.server = new WebSocketServer({ server: http, path: this.options.path ?? '/realtime' });

    this.server.on('connection', (socket, request) => this.accept(socket, request));

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
          this.connections.delete(socket);
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
    const connection: Connection = { socket, channels: new Set(), alive: true };
    this.connections.set(socket, connection);

    socket.on('pong', () => {
      connection.alive = true;
    });

    socket.on('close', () => this.connections.delete(socket));
    socket.on('error', () => socket.terminate());

    socket.on('message', (raw) => {
      const frame = parseFrame<ClientFrame>(String(raw));
      if (!frame) return;

      void this.handle(connection, request, frame);
    });
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
          const since = frame.since?.[channel] ?? 0;
          const answer = await resume(this.options.backlog, channel, since);

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
