import type { Redis } from 'ioredis';
import type { BacklogPort } from '../server/backlog';
import type { RealtimeEvent } from '../wire';

export interface RedisBacklogOptions {
  /** Key prefix, so two products may share a Redis without colliding. */
  readonly prefix?: string;
  /** How many events a channel keeps. The bound a `gap` frame comes from. */
  readonly keep?: number;
  /** How long a channel with no traffic survives. */
  readonly ttlSeconds?: number;
}

/**
 * Assigns the number and stores the event **in one round trip**.
 *
 * A Lua script rather than `INCR` and then `ZADD`, and this is the whole reason
 * this file is longer than it looks. Two calls can come apart: a process that
 * dies between them has handed out sequence 413 and stored nothing, and no
 * amount of later care can fill that hole — every client that reaches it is
 * told the backlog starts at 414 and reloads, for ever, for an event that never
 * existed.
 *
 * Redis runs a script atomically, so the number and the row arrive together or
 * neither does.
 */
const APPEND = `
  local seq = redis.call('INCR', KEYS[1])
  redis.call('ZADD', KEYS[2], seq, ARGV[1] .. seq .. ARGV[2])
  redis.call('ZREMRANGEBYRANK', KEYS[2], 0, -1 - tonumber(ARGV[3]))
  redis.call('EXPIRE', KEYS[1], ARGV[4])
  redis.call('EXPIRE', KEYS[2], ARGV[4])
  return seq
`;

/**
 * A channel's recent past, in Redis, shared by every gateway process.
 *
 * A sorted set scored by sequence number: `ZRANGEBYSCORE` is the resume, the
 * first and last members are the bounds, and `ZREMRANGEBYRANK` is what keeps it
 * bounded. A stream would also work and costs a second concept; a list would
 * make "everything after 412" a scan.
 */
export class RedisBacklog implements BacklogPort {
  private readonly prefix: string;
  private readonly keep: number;
  private readonly ttl: number;

  constructor(
    private readonly redis: Redis,
    options: RedisBacklogOptions = {},
  ) {
    this.prefix = options.prefix ?? 'realtime';
    this.keep = options.keep ?? 500;
    /*
     * A day by default. Long enough that a display switched off overnight
     * resumes in the morning; short enough that a channel nobody uses does not
     * sit in memory for ever — a venue that closes a station should not cost
     * anything by tomorrow.
     */
    this.ttl = options.ttlSeconds ?? 24 * 60 * 60;
  }

  async append(
    channel: string,
    event: Omit<RealtimeEvent, 'seq' | 'channel'>,
  ): Promise<RealtimeEvent> {
    const body = JSON.stringify({ ...event, channel });

    /*
     * The sequence number is spliced into the stored JSON by the script, so the
     * row and its number cannot disagree. `{"seq":` … `,"rest":…}` — the two
     * halves are passed as arguments because Lua has no JSON encoder here and
     * building the string in Redis is cheaper than a second round trip to
     * rewrite it.
     */
    const seq = (await this.redis.eval(
      APPEND,
      2,
      this.seqKey(channel),
      this.logKey(channel),
      '{"seq":',
      `,${body.slice(1)}`,
      String(this.keep),
      String(this.ttl),
    )) as number;

    return { ...event, channel, seq };
  }

  async since(channel: string, since: number): Promise<readonly RealtimeEvent[]> {
    const rows = await this.redis.zrangebyscore(this.logKey(channel), `(${since}`, '+inf');

    return rows.flatMap((row) => {
      try {
        return [JSON.parse(row) as RealtimeEvent];
      } catch {
        // A row this process cannot read is one event, and losing it silently
        // would be a gap nobody detects. Dropping it here means the client sees
        // the gap and resynchronises, which is the honest failure.
        return [];
      }
    });
  }

  async bounds(channel: string): Promise<{ oldest: number; latest: number }> {
    const [first, last] = await Promise.all([
      this.redis.zrange(this.logKey(channel), 0, 0, 'WITHSCORES'),
      this.redis.zrange(this.logKey(channel), -1, -1, 'WITHSCORES'),
    ]);

    if (first.length < 2 || last.length < 2) return { oldest: 0, latest: 0 };

    return { oldest: Number(first[1]), latest: Number(last[1]) };
  }

  private seqKey(channel: string): string {
    return `${this.prefix}:seq:${channel}`;
  }

  private logKey(channel: string): string {
    return `${this.prefix}:log:${channel}`;
  }
}
