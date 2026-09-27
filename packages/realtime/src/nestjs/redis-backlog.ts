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
 *
 * **A channel starts at the Redis server's clock, in milliseconds**, not at 1.
 * The counter expires with the channel, so a channel that went quiet for a day
 * and is used again starts over — and starting over at 1 numbered its next
 * event below what a page left open overnight had already seen. That page
 * skipped it as a duplicate, and every event after it up to its old position,
 * and nothing told it. Starting at the clock numbers the new run above anything
 * the old one handed out, unless it averaged more than one event a millisecond
 * for its whole life, so an open page sees a jump — a gap — and resynchronises.
 * Where the run began is kept beside it, because a client that joined the
 * channel empty stands at 0 and is owed everything from there.
 *
 * The numbers are formatted with `%d` wherever they become text. Lua 5.1
 * writes a number with at most fourteen significant digits, so a sequence that
 * outgrew them would be stored as an exponent — a corrupted row, not an error.
 */
const APPEND = `
  local seq
  if redis.call('EXISTS', KEYS[1]) == 1 then
    seq = redis.call('INCR', KEYS[1])
  else
    local now = redis.call('TIME')
    seq = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
    redis.call('SET', KEYS[1], string.format('%d', seq))
    redis.call('SET', KEYS[3], string.format('%d', seq))
  end
  local id = string.format('%d', seq)
  redis.call('ZADD', KEYS[2], id, ARGV[1] .. id .. ARGV[2])
  redis.call('ZREMRANGEBYRANK', KEYS[2], 0, -1 - tonumber(ARGV[3]))
  redis.call('EXPIRE', KEYS[1], ARGV[4])
  redis.call('EXPIRE', KEYS[2], ARGV[4])
  redis.call('EXPIRE', KEYS[3], ARGV[4])
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
      3,
      this.seqKey(channel),
      this.logKey(channel),
      this.firstKey(channel),
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

  async bounds(channel: string): Promise<{ oldest: number; latest: number; first?: number }> {
    const [head, tail, begun] = await Promise.all([
      this.redis.zrange(this.logKey(channel), 0, 0, 'WITHSCORES'),
      this.redis.zrange(this.logKey(channel), -1, -1, 'WITHSCORES'),
      this.redis.get(this.firstKey(channel)),
    ]);

    if (head.length < 2 || tail.length < 2) return { oldest: 0, latest: 0 };

    return {
      oldest: Number(head[1]),
      latest: Number(tail[1]),
      // Absent for a channel begun before runs were recorded, which began at 1.
      ...(begun === null ? {} : { first: Number(begun) }),
    };
  }

  private seqKey(channel: string): string {
    return `${this.prefix}:seq:${channel}`;
  }

  private logKey(channel: string): string {
    return `${this.prefix}:log:${channel}`;
  }

  /** Where the channel's current run began: what a client standing at 0 is owed from. */
  private firstKey(channel: string): string {
    return `${this.prefix}:first:${channel}`;
  }
}
