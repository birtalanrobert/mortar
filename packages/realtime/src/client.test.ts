import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeClient, type SocketLike } from './client';
import type { RealtimeEvent, ServerFrame } from './wire';

/**
 * A fake socket, so the tests need no browser and no network.
 *
 * What is under test is the *protocol* — when a resume is asked for, what
 * happens to a gap, whether polling starts when a socket will not hold — and
 * none of that is a property of any particular WebSocket implementation.
 */
class FakeSocket implements SocketLike {
  sent: string[] = [];
  closed = false;

  onopen: ((event: unknown) => unknown) | null = null;
  onclose: ((event: unknown) => unknown) | null = null;
  onerror: ((event: unknown) => unknown) | null = null;
  onmessage: ((event: { data: unknown }) => unknown) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.onclose?.({});
  }

  open(): void {
    this.onopen?.({});
  }

  deliver(frame: ServerFrame): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  /** What was sent, parsed, so a test reads intent rather than JSON. */
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
}

const event = (channel: string, seq: number): RealtimeEvent => ({
  channel,
  seq,
  type: 'ticket.created',
  data: { id: `t${seq}` },
  at: 1_000,
});

describe('a client that can prove what it has seen', () => {
  let socket: FakeSocket;
  let received: RealtimeEvent[];
  let states: string[];
  let resyncs: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    socket = new FakeSocket();
    received = [];
    states = [];
    resyncs = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const client = () =>
    new RealtimeClient({
      url: 'wss://example.test/realtime',
      pollUrl: 'https://example.test/realtime/poll',
      channels: ['station:grill'],
      onEvent: (one) => received.push(one),
      onState: (state) => states.push(state),
      onResync: (channel) => resyncs.push(channel),
      socketFactory: () => socket,
      now: () => Date.now(),
    });

  it('subscribes on open, and says where it stands', () => {
    const one = client();
    one.start();
    socket.open();

    // Nothing seen yet, so nothing to resume from — a new screen does not want
    // yesterday's tickets.
    expect(socket.frames()[0]).toEqual({
      kind: 'subscribe',
      channels: ['station:grill'],
      since: {},
    });

    one.stop();
  });

  it('resumes from where it stood rather than from now', () => {
    const one = client();
    one.start();
    socket.open();
    socket.deliver({ kind: 'event', event: event('station:grill', 412) });
    socket.deliver({ kind: 'event', event: event('station:grill', 413) });

    /*
     * The connection drops, and the client reopens it on its own schedule —
     * driven here rather than faked, because `open()` is what re-attaches the
     * socket and a test that shortcuts it proves nothing about reconnection.
     */
    socket.close();
    vi.advanceTimersByTime(2_000);
    socket.open();

    /*
     * The window a reconnection exists to cover. Subscribing from now would
     * lose exactly the tickets that arrived while the display was away, and the
     * kitchen would never know.
     */
    const last = socket.frames().at(-1);
    expect(last).toMatchObject({ since: { 'station:grill': 413 } });

    one.stop();
  });

  it('notices a jump and asks again, without moving its cursor', () => {
    const one = client();
    one.start();
    socket.open();
    socket.deliver({ kind: 'event', event: event('station:grill', 412) });
    socket.deliver({ kind: 'event', event: event('station:grill', 415) });

    // The jumped event is not delivered: rendering 415 after 412 and believing
    // it is up to date is the failure this package exists to prevent.
    expect(received.map((one) => one.seq)).toEqual([412]);
    expect(resyncs).toEqual(['station:grill']);

    // And the resume asks from 412, not from 415.
    expect(socket.frames().at(-1)).toMatchObject({ since: { 'station:grill': 412 } });

    one.stop();
  });

  it('delivers a replayed event once, however many times it arrives', () => {
    const one = client();
    one.start();
    socket.open();
    socket.deliver({ kind: 'event', event: event('station:grill', 412) });
    socket.deliver({ kind: 'event', event: event('station:grill', 412) });
    socket.deliver({ kind: 'event', event: event('station:grill', 413) });

    /*
     * Duplicates are normal by design: a resume overlaps the live stream,
     * because the alternative is a race in which the gap between "here is your
     * backlog" and "you are now live" loses an event. The client is what makes
     * the overlap harmless.
     */
    expect(received.map((one) => one.seq)).toEqual([412, 413]);

    one.stop();
  });

  it('tells the product to reload when the server cannot replay far enough', () => {
    const one = client();
    one.start();
    socket.open();
    socket.deliver({ kind: 'gap', channel: 'station:grill', from: 900 });

    // The honest answer to "you were away too long" is a reload, not a partial
    // replay that looks complete.
    expect(resyncs).toEqual(['station:grill']);
    expect(one.seenAt('station:grill')).toBe(900);

    one.stop();
  });

  it('says out loud when it is no longer live', () => {
    const one = client();
    one.start();
    socket.open();
    socket.close();

    /*
     * §5.10. A display that has gone quiet looks exactly like a kitchen with no
     * orders, so the state has to reach the screen — this is the signal it is
     * drawn from.
     */
    expect(states).toContain('live');
    expect(states.at(-1)).toBe('polling');

    one.stop();
  });

  it('closes a socket that has stopped answering', () => {
    const one = client();
    one.start();
    socket.open();

    // A TCP connection can be open one way and dead the other for minutes. Two
    // missed heartbeats and the client stops believing it.
    vi.advanceTimersByTime(15_000);
    expect(socket.frames().at(-1)).toMatchObject({ kind: 'ping' });

    vi.advanceTimersByTime(40_000);
    expect(socket.closed).toBe(true);

    one.stop();
  });
});

describe('the polling fallback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts at once when a socket will not open, rather than after a backoff', async () => {
    const received: RealtimeEvent[] = [];
    const asked: string[] = [];

    const one = new RealtimeClient({
      url: 'wss://example.test/realtime',
      pollUrl: 'https://example.test/poll',
      channels: ['station:grill'],
      onEvent: (event) => received.push(event),
      socketFactory: () => {
        // A venue whose network eats WebSockets: a hotel, a corporate guest
        // network, an ageing router.
        throw new Error('blocked');
      },
      fetch: (async (url: string) => {
        asked.push(String(url));
        return {
          ok: true,
          json: async () => ({ events: [event('station:grill', 1)] }),
        };
      }) as unknown as typeof fetch,
    });

    one.start();
    await vi.advanceTimersByTimeAsync(0);

    /*
     * Immediately, and the socket is retried behind it. A display that shows a
     * spinner through an exponential backoff is a display the kitchen turns
     * off.
     */
    expect(one.connection).toBe('polling');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('since=');
    expect(received.map((event) => event.seq)).toEqual([1]);

    one.stop();
  });

  it('asks from where it stands, so the same events do not arrive twice', async () => {
    const received: RealtimeEvent[] = [];
    const asked: string[] = [];

    const one = new RealtimeClient({
      url: 'wss://example.test/realtime',
      pollUrl: 'https://example.test/poll',
      channels: ['station:grill'],
      pollMs: 1_000,
      onEvent: (event) => received.push(event),
      socketFactory: () => {
        throw new Error('blocked');
      },
      fetch: (async (url: string) => {
        asked.push(String(url));
        return {
          ok: true,
          json: async () => ({ events: [event('station:grill', asked.length)] }),
        };
      }) as unknown as typeof fetch,
    });

    one.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);

    // The second ask carries the first's answer, which is what makes polling a
    // fallback for the *same* protocol rather than a different one.
    expect(asked[1]).toContain(encodeURIComponent('{"station:grill":1}'));
    expect(received.map((event) => event.seq)).toEqual([1, 2]);

    one.stop();
  });
});
