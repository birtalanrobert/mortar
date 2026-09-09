import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createTestRedis, flushTestRedis } from '@birtalanrobert/redis';
import type { Redis } from 'ioredis';
import { RealtimePublisher } from '../server/publisher';
import { RealtimeClient } from '../client';
import type { RealtimeEvent } from '../wire';
import { RedisBacklog } from './redis-backlog';
import { RedisBroadcast } from './redis-broadcast';
import { RealtimeSocketServer } from './socket-server';
import { pollSince } from './polling';

/**
 * The whole thing, over a real socket and a real Redis.
 *
 * Everything worth being certain about here is a property of the parts
 * together: whether a Lua script really hands out one number per event, whether
 * a reconnection really receives what it missed, whether a second gateway
 * process really hears about an event published on the first. A mocked version
 * asserts that this code calls the functions it calls.
 */
describe('a realtime gateway', () => {
  let redis: Redis;
  let subscriber: Redis;
  let backlog: RedisBacklog;
  let publisher: RealtimePublisher;
  let server: RealtimeSocketServer;
  let http: Server;
  let port = 0;

  beforeAll(async () => {
    redis = createTestRedis();
    subscriber = createTestRedis();

    backlog = new RedisBacklog(redis, { prefix: 'test-realtime', keep: 5 });
    publisher = new RealtimePublisher({ backlog });

    server = new RealtimeSocketServer({
      publisher,
      backlog,
      // Everything, because who may read a channel is the product's question
      // and this suite is not the product.
      authorise: (_request, channels) => channels,
      heartbeatMs: 60_000,
    });

    http = createServer();
    server.attach(http);

    await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
    port = (http.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await server.close();
    await new Promise<void>((done) => http.close(() => done()));
    redis.disconnect();
    subscriber.disconnect();
  });

  beforeEach(async () => {
    await flushTestRedis(redis);
  });

  const connect = (channels: string[]) => {
    const received: RealtimeEvent[] = [];
    const resyncs: string[] = [];

    const client = new RealtimeClient({
      url: `ws://127.0.0.1:${port}/realtime`,
      channels,
      onEvent: (event) => received.push(event),
      onResync: (channel) => resyncs.push(channel),
      socketFactory: (url) => new WebSocket(url) as never,
      heartbeatMs: 60_000,
    });

    return { client, received, resyncs };
  };

  const settle = (ms = 150) => new Promise((done) => setTimeout(done, ms));

  it('delivers what is published while a client is connected', async () => {
    const { client, received } = connect(['station:grill']);
    client.start();
    await settle();

    await publisher.publish({ channel: 'station:grill', type: 'ticket.created', data: { id: 1 } });
    await settle();

    expect(received.map((event) => event.seq)).toEqual([1]);
    client.stop();
  });

  it('hands out one number per event, under a burst', async () => {
    /*
     * The Lua script's reason for existing. Twenty publishes at once, and the
     * numbers must be 1 to 20 with nothing repeated and nothing skipped — a
     * repeated number is two events a client cannot tell apart, and a skipped
     * one is a gap that makes every client reload for ever.
     */
    const published = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        publisher.publish({ channel: 'burst', type: 'x', data: { index } }),
      ),
    );

    const seqs = published.map((event) => event.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
  });

  it('sends a reconnecting client exactly what it missed', async () => {
    const { client, received } = connect(['station:grill']);
    client.start();
    await settle();

    await publisher.publish({ channel: 'station:grill', type: 'a', data: {} });
    await settle();

    // The display loses its network, and three tickets arrive while it is away.
    client.stop();
    for (const type of ['b', 'c', 'd']) {
      await publisher.publish({ channel: 'station:grill', type, data: {} });
    }

    client.start();
    await settle(300);

    /*
     * The window a reconnection exists to cover. A client that subscribed from
     * now would have a kitchen missing three tickets and no way to know.
     */
    expect(received.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    client.stop();
  });

  it('tells a client that was away too long to start again', async () => {
    const { client, received, resyncs } = connect(['deep']);
    client.start();
    await settle();

    await publisher.publish({ channel: 'deep', type: 'a', data: {} });
    await settle();
    client.stop();

    // The backlog keeps five. Eight more arrive, so what this client last saw
    // has been trimmed away.
    for (let index = 0; index < 8; index += 1) {
      await publisher.publish({ channel: 'deep', type: 'x', data: { index } });
    }

    client.start();
    await settle(300);

    /*
     * A `gap` frame, not four of the eight events. A partial replay that looks
     * complete is the failure this package exists to prevent, and the product's
     * answer is to fetch its own state again.
     */
    expect(resyncs).toEqual(['deep']);

    // The one it saw while it was connected, and nothing from the eight it
    // missed: a partial replay that looks complete is the failure this package
    // exists to prevent, so the product is told to fetch its own state instead.
    expect(received.map((event) => event.type)).toEqual(['a']);
    client.stop();
  });

  it('starts a new screen at now rather than at this morning', async () => {
    for (let index = 0; index < 4; index += 1) {
      await publisher.publish({ channel: 'station:pass', type: 'x', data: { index } });
    }

    const { client, received, resyncs } = connect(['station:pass']);
    client.start();
    await settle(200);

    // A screen switched on at six in the evening does not want the tickets from
    // lunch — and must not reload for nothing on every boot.
    expect(received).toEqual([]);
    expect(resyncs).toEqual([]);
    expect(client.seenAt('station:pass')).toBe(4);

    client.stop();
  });

  it('carries an event from one gateway process to another', async () => {
    /*
     * Four processes behind a load balancer, and a display's socket is held by
     * whichever one it reached. Without the fan-out, a ticket published on the
     * other process reaches a third of the kitchen — and the rest are not told
     * they are missing it.
     */
    const broadcast = new RedisBroadcast(redis, subscriber, 'test-realtime');
    await broadcast.listen(publisher);

    const { client, received } = connect(['station:bar']);
    client.start();
    await settle();

    // A second process: its own publisher, the same backlog and the same Redis.
    const elsewhere = new RealtimePublisher({ backlog, broadcast: broadcast.send });
    await elsewhere.publish({ channel: 'station:bar', type: 'ticket.created', data: {} });
    await settle(300);

    expect(received.map((event) => event.type)).toEqual(['ticket.created']);
    client.stop();
  });

  it('answers the polling fallback with the same events as the socket', async () => {
    for (const type of ['a', 'b']) {
      await publisher.publish({ channel: 'station:fry', type, data: {} });
    }

    const answer = await pollSince(backlog, ['station:fry'], { 'station:fry': 1 });

    /*
     * The same `resume` the socket uses, which is what stops the fallback being
     * a second protocol that behaves differently on the day it is needed.
     */
    expect(answer.events.map((event) => event.type)).toEqual(['b']);
    expect(answer.gaps).toEqual([]);
    expect(answer.latest).toEqual({ 'station:fry': 2 });
  });

  it('names only the channel a poller is too far behind in', async () => {
    for (let index = 0; index < 8; index += 1) {
      await publisher.publish({ channel: 'busy', type: 'x', data: { index } });
    }
    await publisher.publish({ channel: 'quiet', type: 'x', data: {} });

    const answer = await pollSince(backlog, ['busy', 'quiet'], { busy: 1, quiet: 1 });

    // A client current in one channel and stranded in another must not be made
    // to reload both.
    expect(answer.gaps).toEqual(['busy']);
    expect(answer.events).toEqual([]);
  });

  it('sends a client only the channels it subscribed to', async () => {
    const { client, received } = connect(['station:grill']);
    client.start();
    await settle();

    await publisher.publish({ channel: 'station:pass', type: 'other', data: {} });
    await publisher.publish({ channel: 'station:grill', type: 'mine', data: {} });
    await settle(200);

    expect(received.map((event) => event.type)).toEqual(['mine']);
    client.stop();
  });
});
