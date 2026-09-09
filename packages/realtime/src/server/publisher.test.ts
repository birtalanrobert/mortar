import { describe, expect, it } from 'vitest';
import { MemoryBacklog } from './backlog';
import { RealtimePublisher } from './publisher';
import { resume } from './resume';

/**
 * The guarantees, without a network.
 *
 * Everything this package promises rests on a sequence number being handed out
 * exactly once per channel and an event being durable before anybody is told
 * about it. Both are testable here, and both are the kind of thing that is
 * quietly wrong in production for weeks.
 */
describe('publishing', () => {
  it('numbers a channel from one, and never repeats', async () => {
    const backlog = new MemoryBacklog();
    const publisher = new RealtimePublisher({ backlog });

    const first = await publisher.publish({ channel: 'station:grill', type: 'a', data: {} });
    const second = await publisher.publish({ channel: 'station:grill', type: 'b', data: {} });

    expect([first.seq, second.seq]).toEqual([1, 2]);
  });

  it('numbers each channel on its own', async () => {
    const backlog = new MemoryBacklog();
    const publisher = new RealtimePublisher({ backlog });

    await publisher.publish({ channel: 'station:grill', type: 'a', data: {} });
    const pass = await publisher.publish({ channel: 'station:pass', type: 'a', data: {} });

    /*
     * A global counter would make every subscriber's gap detection depend on
     * traffic they cannot see — a kitchen display would think it had missed the
     * messages a guest's phone received, and reload for ever.
     */
    expect(pass.seq).toBe(1);
  });

  it('stores the event before telling anybody about it', async () => {
    const backlog = new MemoryBacklog();
    const publisher = new RealtimePublisher({ backlog });

    const seen: number[] = [];
    publisher.onEvent(() => {
      // At the moment a subscriber hears about it, a reconnecting client must
      // already be able to be given it.
      void backlog.since('station:grill', 0).then((events) => seen.push(events.length));
    });

    await publisher.publish({ channel: 'station:grill', type: 'a', data: {} });
    await Promise.resolve();

    expect(seen).toEqual([1]);
  });

  it('keeps one subscriber’s failure away from the others', async () => {
    const backlog = new MemoryBacklog();
    const publisher = new RealtimePublisher({ backlog });

    const reached: string[] = [];
    publisher.onEvent(() => {
      throw new Error('this socket has gone');
    });
    publisher.onEvent(() => reached.push('the other screen'));

    await publisher.publish({ channel: 'station:grill', type: 'a', data: {} });

    // One closed connection must not stop the kitchen's other three screens
    // from being told.
    expect(reached).toEqual(['the other screen']);
  });

  it('hands a broadcast event on without numbering it again', () => {
    const backlog = new MemoryBacklog();
    const publisher = new RealtimePublisher({ backlog });

    const seen: number[] = [];
    publisher.onEvent((event) => seen.push(event.seq));

    /*
     * It already has its number, assigned by whichever process published it.
     * Appending here would give the same event two numbers, and every client a
     * gap that will never close.
     */
    publisher.receiveBroadcast({
      channel: 'station:grill',
      seq: 412,
      type: 'a',
      data: {},
      at: 0,
    });

    expect(seen).toEqual([412]);
  });

  it('tells the other processes, after the local sockets', async () => {
    const backlog = new MemoryBacklog();
    const order: string[] = [];

    const publisher = new RealtimePublisher({
      backlog,
      broadcast: () => {
        order.push('broadcast');
      },
    });

    publisher.onEvent(() => order.push('local'));
    await publisher.publish({ channel: 'station:grill', type: 'a', data: {} });

    // The fastest path first. Four gateway processes behind a load balancer all
    // hear about it; the one holding the socket hears first.
    expect(order).toEqual(['local', 'broadcast']);
  });
});

describe('answering a client that says where it stands', () => {
  const fill = async (count: number) => {
    const backlog = new MemoryBacklog(3);
    const publisher = new RealtimePublisher({ backlog });

    for (let index = 0; index < count; index += 1) {
      await publisher.publish({ channel: 'c', type: 'a', data: { index } });
    }

    return backlog;
  };

  it('sends nothing to a client that is current', async () => {
    const backlog = await fill(3);

    // The commonest case, and it must be cheap: a display polling every three
    // seconds mostly asks for nothing.
    expect(await resume(backlog, 'c', 3)).toMatchObject({ events: [], gap: null, latest: 3 });
  });

  it('sends what came after', async () => {
    const backlog = await fill(3);
    const answer = await resume(backlog, 'c', 1);

    expect(answer.events.map((event) => event.seq)).toEqual([2, 3]);
    expect(answer.gap).toBeNull();
  });

  it('starts a new client at now rather than at the beginning of time', async () => {
    const backlog = await fill(3);

    /*
     * A screen bolted to a wall and switched on at six in the evening does not
     * want the tickets from lunch — and a `gap` here would make it reload for
     * nothing on every boot.
     */
    expect(await resume(backlog, 'c', 0)).toMatchObject({ events: [], gap: null, latest: 3 });
  });

  it('refuses to half-answer a client that was away too long', async () => {
    // Kept: 3. Published: 6. Everything before 4 is gone.
    const backlog = await fill(6);
    const answer = await resume(backlog, 'c', 1);

    /*
     * The honest answer is "I cannot tell you", not four of the five events you
     * missed. A partial replay that looks complete is the failure this package
     * exists to prevent.
     */
    expect(answer.events).toEqual([]);
    expect(answer.gap).toMatchObject({ kind: 'gap', channel: 'c', from: 6 });
  });

  it('says nothing at all about a channel with no events', async () => {
    const backlog = new MemoryBacklog();

    // A station that has had no tickets today is not a gap.
    expect(await resume(backlog, 'quiet', 0)).toMatchObject({ events: [], gap: null, latest: 0 });
  });

  it('serves a client that is exactly at the edge of what is kept', async () => {
    const backlog = await fill(6);
    const answer = await resume(backlog, 'c', 3);

    // The oldest kept is 4, so a client at 3 can still be told everything —
    // one further back and it could not. Off by one here is a display that
    // reloads on every reconnection, or one that never does.
    expect(answer.events.map((event) => event.seq)).toEqual([4, 5, 6]);
    expect(answer.gap).toBeNull();
  });
});
