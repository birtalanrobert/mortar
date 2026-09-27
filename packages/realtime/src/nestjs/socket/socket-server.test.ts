import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { MemoryBacklog, type BacklogPort } from '../../server/backlog';
import { RealtimePublisher } from '../../server/publisher';
import type { ServerFrame } from '../../wire';
import { RealtimeSocketServer, type SocketServerOptions } from './index';

/**
 * The gateway's door: who is let in, what a frame may weigh, and what happens
 * when a subscription cannot be answered.
 *
 * A real HTTP server and a real `ws` client, and a backlog in memory — the
 * behaviour under test is the handshake and the connection, which a mocked
 * socket would only describe.
 */
describe('a realtime gateway at its door', () => {
  let http: Server | null = null;
  let server: RealtimeSocketServer | null = null;

  afterEach(async () => {
    await server?.close();
    await new Promise<void>((done) => (http ? http.close(() => done()) : done()));
    server = null;
    http = null;
  });

  const start = async (options: Partial<SocketServerOptions> = {}): Promise<number> => {
    const backlog = options.backlog ?? new MemoryBacklog();
    server = new RealtimeSocketServer({
      publisher: new RealtimePublisher({ backlog }),
      backlog,
      authorise: (_request, channels) => channels,
      heartbeatMs: 60_000,
      ...options,
    });
    http = createServer();
    server.attach(http);
    await new Promise<void>((done) => http!.listen(0, '127.0.0.1', done));
    return (http.address() as AddressInfo).port;
  };

  /** The status an upgrade was refused with, or the socket it opened. */
  const knock = (url: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number } | { socket: WebSocket }>((settle, fail) => {
      const socket = new WebSocket(url, { headers });
      socket.once('unexpected-response', (_request, response) => {
        settle({ status: response.statusCode ?? 0 });
        socket.terminate();
      });
      socket.once('open', () => settle({ socket }));
      socket.once('error', (error) => {
        // After a refusal `ws` reports the aborted handshake too; the status
        // above has already answered.
        if (!/Unexpected server response/.test(error.message)) fail(error);
      });
    });

  const closed = (socket: WebSocket) =>
    new Promise<number>((done) => socket.once('close', (code) => done(code)));

  const frames = (socket: WebSocket) => {
    const seen: ServerFrame[] = [];
    socket.on('message', (raw) => seen.push(JSON.parse(String(raw)) as ServerFrame));
    return seen;
  };

  const settle = (ms = 100) => new Promise((done) => setTimeout(done, ms));

  it('refuses an upgrade its admit declines, with 403, before any connection exists', async () => {
    const asked: IncomingMessage[] = [];
    const port = await start({
      admit: (request) => {
        asked.push(request);
        return request.headers.cookie === 'session=valid';
      },
    });

    const answer = await knock(`ws://127.0.0.1:${port}/realtime`, { cookie: 'session=forged' });

    expect(answer).toEqual({ status: 403 });
    expect(asked).toHaveLength(1);
    expect(server!.connectionCount).toBe(0);
  });

  it('opens a connection its admit accepts, asynchronously', async () => {
    const port = await start({
      admit: async (request) => {
        await settle(10);
        return request.headers.cookie === 'session=valid';
      },
    });

    const answer = await knock(`ws://127.0.0.1:${port}/realtime`, { cookie: 'session=valid' });
    if (!('socket' in answer)) throw new Error(`refused with ${answer.status}`);
    const seen = frames(answer.socket);

    answer.socket.send(JSON.stringify({ kind: 'subscribe', channels: ['room:1'] }));
    await settle();

    expect(seen).toEqual([{ kind: 'welcome', channels: { 'room:1': 0 } }]);
    answer.socket.close();
  });

  it('answers 503 when admit cannot decide, and reports why', async () => {
    const reported: unknown[] = [];
    const failure = new Error('the session store is down');
    const port = await start({
      admit: () => Promise.reject(failure),
      onError: (error) => reported.push(error),
    });

    const answer = await knock(`ws://127.0.0.1:${port}/realtime`);

    // A check that could not be made is not a caller refused.
    expect(answer).toEqual({ status: 503 });
    expect(reported).toEqual([failure]);
  });

  it('does not ask admit about an upgrade to another path', async () => {
    let asked = 0;
    const port = await start({
      admit: () => {
        asked += 1;
        return true;
      },
    });

    const answer = await knock(`ws://127.0.0.1:${port}/elsewhere`);

    expect(answer).toEqual({ status: 400 });
    expect(asked).toBe(0);
  });

  it('closes a connection whose subscription authorise could not answer, and reports it', async () => {
    /*
     * Before this, the rejection escaped the message handler — an unhandled
     * rejection, which Vitest fails a run for and Node ends a process for.
     */
    const reported: unknown[] = [];
    const failure = new Error('the database is down');
    const port = await start({
      authorise: () => Promise.reject(failure),
      onError: (error) => reported.push(error),
    });

    const answer = await knock(`ws://127.0.0.1:${port}/realtime`);
    if (!('socket' in answer)) throw new Error(`refused with ${answer.status}`);
    const seen = frames(answer.socket);
    const code = closed(answer.socket);

    answer.socket.send(JSON.stringify({ kind: 'subscribe', channels: ['room:1'] }));

    // 1011: the client goes to polling and back, resuming where it stood,
    // rather than believing in a subscription it does not have.
    expect(await code).toBe(1011);
    expect(seen).toEqual([]);
    expect(reported).toEqual([failure]);
  });

  it('closes a connection whose subscription the backlog could not answer, and reports it', async () => {
    const reported: unknown[] = [];
    const failure = new Error('redis is down');
    const broken: BacklogPort = {
      append: () => Promise.reject(failure),
      since: () => Promise.reject(failure),
      bounds: () => Promise.reject(failure),
    };
    const port = await start({ backlog: broken, onError: (error) => reported.push(error) });

    const answer = await knock(`ws://127.0.0.1:${port}/realtime`);
    if (!('socket' in answer)) throw new Error(`refused with ${answer.status}`);
    const code = closed(answer.socket);

    answer.socket.send(
      JSON.stringify({ kind: 'subscribe', channels: ['room:1'], since: { 'room:1': 3 } }),
    );

    expect(await code).toBe(1011);
    expect(reported).toEqual([failure]);
  });

  it('survives an onError that throws', async () => {
    const port = await start({
      authorise: () => Promise.reject(new Error('the database is down')),
      onError: () => {
        throw new Error('the logger is broken too');
      },
    });

    const answer = await knock(`ws://127.0.0.1:${port}/realtime`);
    if (!('socket' in answer)) throw new Error(`refused with ${answer.status}`);
    const code = closed(answer.socket);
    answer.socket.send(JSON.stringify({ kind: 'subscribe', channels: ['room:1'] }));

    expect(await code).toBe(1011);
  });

  it('closes a connection that sends a frame heavier than maxPayload', async () => {
    const port = await start({ maxPayload: 1024 });

    const answer = await knock(`ws://127.0.0.1:${port}/realtime`);
    if (!('socket' in answer)) throw new Error(`refused with ${answer.status}`);
    const code = closed(answer.socket);

    answer.socket.send(JSON.stringify({ kind: 'subscribe', channels: ['x'.repeat(2048)] }));

    expect(await code).toBe(1009);
    await settle();
    expect(server!.connectionCount).toBe(0);
  });

  it('holds a client to 64 KiB unless told otherwise', async () => {
    const port = await start();

    const answer = await knock(`ws://127.0.0.1:${port}/realtime`);
    if (!('socket' in answer)) throw new Error(`refused with ${answer.status}`);
    const code = closed(answer.socket);

    answer.socket.send(JSON.stringify({ kind: 'subscribe', channels: ['x'.repeat(64 * 1024)] }));

    expect(await code).toBe(1009);
  });
});
