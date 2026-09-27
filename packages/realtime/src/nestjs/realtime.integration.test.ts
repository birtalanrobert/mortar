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
import { RealtimeSocketServer } from './socket';
import { parsePollQuery, pollSince } from './polling';

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

    const sent = await publisher.publish({
      channel: 'station:grill',
      type: 'ticket.created',
      data: { id: 1 },
    });
    await settle();

    expect(received.map((event) => event.seq)).toEqual([sent.seq]);
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
    const first = seqs[0]!;
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, index) => first + index));
  });

  it('sends a reconnecting client exactly what it missed', async () => {
    const { client, received } = connect(['station:grill']);
    client.start();
    await settle();

    const first = await publisher.publish({ channel: 'station:grill', type: 'a', data: {} });
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
    expect(received.map((event) => event.type)).toEqual(['a', 'b', 'c', 'd']);
    expect(received.map((event) => event.seq - first.seq)).toEqual([0, 1, 2, 3]);
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
    let last = 0;
    for (let index = 0; index < 4; index += 1) {
      last = (await publisher.publish({ channel: 'station:pass', type: 'x', data: { index } })).seq;
    }

    const { client, received, resyncs } = connect(['station:pass']);
    client.start();
    await settle(200);

    // A screen switched on at six in the evening does not want the tickets from
    // lunch — and must not reload for nothing on every boot.
    expect(received).toEqual([]);
    expect(resyncs).toEqual([]);
    expect(client.seenAt('station:pass')).toBe(last);

    client.stop();
  });

  it('carries an event from one gateway process to another', async () => {
    /*
     * Four processes behind a load balancer, and a display's socket is held by
     * whichever one it reached. Without the fan-out, a ticket published on the
     * other process reaches a third of the kitchen — and the rest are not told
     * they are missing it.
     */
    const here = new RedisBroadcast(redis, subscriber, 'test-realtime');
    await here.listen(publisher);

    const { client, received } = connect(['station:bar']);
    client.start();
    await settle();

    /*
     * A second process: **its own `RedisBroadcast`**, its own publisher, the
     * same backlog and the same Redis. Two instances rather than one, because
     * each process now recognises its own messages coming back — sharing an
     * instance between the two halves of this test would be modelling one
     * process pretending to be two, which is the thing that stopped being true.
     */
    const there = new RedisBroadcast(redis, subscriber, 'test-realtime');
    const elsewhere = new RealtimePublisher({ backlog, broadcast: there.send });
    await elsewhere.publish({ channel: 'station:bar', type: 'ticket.created', data: {} });
    await settle(300);

    expect(received.map((event) => event.type)).toEqual(['ticket.created']);
    client.stop();
  });

  it('does not hand a process its own broadcast a second time', async () => {
    /*
     * Redis pub/sub delivers to every subscriber on the channel, the sender
     * included. A process that both sends and listens — which is every gateway
     * replica — would otherwise write each of its own events to its sockets
     * twice: once locally, once on the way back.
     *
     * Clients survive it, because a repeated sequence number is `skip`. What
     * nobody survives is not noticing that every screen in the building is
     * being sent twice what it needs, over venue wifi, on a tablet.
     *
     * Its own connections and its own fan-out channel, because the assertion is
     * about how many times something arrives — and every other test in this
     * file has left a listener on the shared subscriber.
     */
    const mine = createTestRedis();
    const theirs = createTestRedis();
    const listening = createTestRedis();
    const alsoListening = createTestRedis();

    const here = new RedisBroadcast(mine, listening, 'test-realtime-echo');
    const there = new RedisBroadcast(theirs, alsoListening, 'test-realtime-echo');

    const local = new RealtimePublisher({ backlog, broadcast: here.send });
    const other = new RealtimePublisher({ backlog });

    await here.listen(local);
    await there.listen(other);

    const seen: RealtimeEvent[] = [];
    const elsewhere: RealtimeEvent[] = [];
    local.onEvent((event) => seen.push(event));
    other.onEvent((event) => elsewhere.push(event));

    const sent = await local.publish({
      channel: 'station:echo',
      type: 'ticket.created',
      data: {},
    });
    await settle(300);

    // Once at home — delivered locally, not again on the way back.
    expect(seen.map((event) => event.seq)).toEqual([sent.seq]);
    // And once at the other process, which is the entire point of sending it.
    expect(elsewhere.map((event) => event.seq)).toEqual([sent.seq]);

    for (const client of [mine, theirs, listening, alsoListening]) client.disconnect();
  });

  it('answers the polling fallback with the same events as the socket', async () => {
    const first = await publisher.publish({ channel: 'station:fry', type: 'a', data: {} });
    const second = await publisher.publish({ channel: 'station:fry', type: 'b', data: {} });

    const answer = await pollSince(backlog, ['station:fry'], { 'station:fry': first.seq });

    /*
     * The same `resume` the socket uses, which is what stops the fallback being
     * a second protocol that behaves differently on the day it is needed.
     */
    expect(answer.events.map((event) => event.type)).toEqual(['b']);
    expect(answer.gaps).toEqual([]);
    expect(answer.latest).toEqual({ 'station:fry': second.seq });
  });

  it('names only the channel a poller is too far behind in', async () => {
    const busy = await publisher.publish({ channel: 'busy', type: 'x', data: { index: 0 } });
    for (let index = 1; index < 8; index += 1) {
      await publisher.publish({ channel: 'busy', type: 'x', data: { index } });
    }
    const quiet = await publisher.publish({ channel: 'quiet', type: 'x', data: {} });

    const answer = await pollSince(backlog, ['busy', 'quiet'], {
      busy: busy.seq,
      quiet: quiet.seq,
    });

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

  it('numbers a channel that was forgotten and used again above what it was, so an open page notices', async () => {
    const { client, received, resyncs } = connect(['sleepy']);
    client.start();
    await settle();

    await publisher.publish({ channel: 'sleepy', type: 'evening', data: {} });
    await settle();

    // A quiet night: what `EXPIRE` does to the channel a day later.
    await redis.del(
      'test-realtime:seq:sleepy',
      'test-realtime:log:sleepy',
      'test-realtime:first:sleepy',
    );

    await publisher.publish({ channel: 'sleepy', type: 'morning', data: {} });
    await settle(300);

    /*
     * Numbered from 1 again, "morning" arrived below where the page stood and
     * was skipped as a duplicate, and nothing said so. Numbered from the clock,
     * it is a jump: the page is told to fetch its state, and carries on.
     */
    expect(resyncs).toContain('sleepy');

    await publisher.publish({ channel: 'sleepy', type: 'noon', data: {} });
    await settle();
    expect(received.map((event) => event.type)).toEqual(['evening', 'noon']);
    client.stop();
  });

  it('replays to a returning client what reached a channel that was empty when it joined', async () => {
    const { client, received, resyncs } = connect(['fresh']);
    client.start();
    await settle();

    // The phone locks, and a timer finishes while it is away.
    client.stop();
    await publisher.publish({ channel: 'fresh', type: 'finished', data: {} });

    client.start();
    await settle(300);

    /*
     * It stood at 0, which is a position. Taken for a newcomer, it was answered
     * from now and never told about the one event it came back for.
     */
    expect(received.map((event) => event.type)).toEqual(['finished']);
    expect(resyncs).toEqual([]);
    client.stop();
  });

  describe('over the polling fallback', () => {
    const polling = (channels: string[]) => {
      const received: RealtimeEvent[] = [];
      const resyncs: string[] = [];

      const client = new RealtimeClient({
        url: `ws://127.0.0.1:${port}/nowhere`,
        pollUrl: 'http://in-process.test/poll',
        channels,
        onEvent: (event) => received.push(event),
        onResync: (channel) => resyncs.push(channel),
        pollMs: 100,
        // A network that eats WebSockets, which is what the fallback is for.
        socketFactory: () => {
          throw new Error('blocked');
        },
        // The product's poll route, in process: what it reads, and what it answers.
        fetch: (async (url: string) => {
          const { channels: asked, since } = parsePollQuery(
            Object.fromEntries(new URL(url).searchParams),
          );
          const body = await pollSince(backlog, asked, since);
          return { ok: true, json: async () => body };
        }) as unknown as typeof fetch,
      });

      return { client, received, resyncs };
    };

    it('delivers the first event of a channel it joined while it was empty', async () => {
      const { client, received } = polling(['station:salad']);
      client.start();
      await settle(250);

      await publisher.publish({ channel: 'station:salad', type: 'first', data: {} });
      await settle(250);

      expect(received.map((event) => event.type)).toEqual(['first']);
      client.stop();
    });

    it('starts again where the channel stands when it fell too far behind', async () => {
      const { client, received, resyncs } = polling(['station:wok']);
      await publisher.publish({ channel: 'station:wok', type: 'before', data: {} });
      client.start();
      await settle(250);
      client.stop();

      // The backlog keeps five; eight arrive while this client is away.
      for (let index = 0; index < 8; index += 1) {
        await publisher.publish({ channel: 'station:wok', type: 'missed', data: { index } });
      }

      client.start();
      await settle(250);
      await publisher.publish({ channel: 'station:wok', type: 'after', data: {} });
      await settle(250);

      /*
       * Told, once, and moved to where the channel stands. Ignoring `gaps`, the
       * poller asked from where it had stood for ever and delivered nothing more.
       */
      expect(resyncs).toEqual(['station:wok']);
      expect(received.map((event) => event.type)).toEqual(['after']);
      client.stop();
    });
  });
});
