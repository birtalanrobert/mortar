import type { RealtimeEvent } from '../wire';

/**
 * Where a channel's recent past is kept, so a client can be told what it
 * missed.
 *
 * A port rather than Redis directly, for the reason every port in this
 * repository exists: the guarantee is testable without a server, and a product
 * that must keep its events somewhere else — a single-process deployment, a
 * test — implements four methods rather than forking anything.
 *
 * **Bounded, and the bound is the whole design.** A backlog that grew for ever
 * would be a second database nobody chose; one that is bounded can fail to
 * answer, and saying so out loud is what keeps a client honest. The failure
 * mode of an unbounded replay is a display that is quietly incomplete.
 */
export interface BacklogPort {
  /**
   * Assigns the next sequence number in a channel and stores the event.
   *
   * One call rather than two, because the number and the storing must not come
   * apart: an event that took 413 and was not stored is a gap nobody can fill,
   * and a client asking for it will be told the backlog starts at 414 and
   * reload for nothing.
   */
  append(channel: string, event: Omit<RealtimeEvent, 'seq' | 'channel'>): Promise<RealtimeEvent>;

  /** Everything after `since`, oldest first. Empty when a client is current. */
  since(channel: string, since: number): Promise<readonly RealtimeEvent[]>;

  /**
   * The oldest sequence still held, and where the channel stands.
   *
   * `oldest` is what makes a `gap` frame possible: a client that asks from
   * before it cannot be served, and must be told rather than sent a partial
   * replay that looks complete.
   */
  bounds(channel: string): Promise<{ oldest: number; latest: number }>;
}

/**
 * A backlog in memory, for tests and for a single-process deployment.
 *
 * Exported rather than kept beside the tests because every product that
 * consumes this package needs a way to test its own use of it without a Redis —
 * otherwise each writes a fake that disagrees with the interface in its own
 * way.
 */
export class MemoryBacklog implements BacklogPort {
  private readonly channels = new Map<string, { events: RealtimeEvent[]; next: number }>();

  constructor(private readonly keep = 500) {}

  async append(
    channel: string,
    event: Omit<RealtimeEvent, 'seq' | 'channel'>,
  ): Promise<RealtimeEvent> {
    const held = this.channels.get(channel) ?? { events: [], next: 1 };
    const stored: RealtimeEvent = { ...event, channel, seq: held.next };

    held.events.push(stored);
    held.next += 1;
    if (held.events.length > this.keep) held.events.splice(0, held.events.length - this.keep);

    this.channels.set(channel, held);
    return stored;
  }

  async since(channel: string, since: number): Promise<readonly RealtimeEvent[]> {
    return (this.channels.get(channel)?.events ?? []).filter((event) => event.seq > since);
  }

  async bounds(channel: string): Promise<{ oldest: number; latest: number }> {
    const held = this.channels.get(channel);
    if (!held || held.events.length === 0) return { oldest: 0, latest: 0 };

    return { oldest: held.events[0]!.seq, latest: held.events.at(-1)!.seq };
  }
}
