import type { Redis } from 'ioredis';

export interface RateLimitResult {
  readonly allowed: boolean;
  /** Requests still permitted in the current window. */
  readonly remaining: number;
  /** Seconds until the caller may retry. Zero when allowed. */
  readonly retryAfter: number;
  readonly limit: number;
}

/**
 * Sliding-window rate limiting, evaluated atomically in Redis.
 *
 * A fixed window lets a caller spend the whole allowance at the end of one
 * window and the whole of the next immediately after — twice the intended rate
 * across the boundary. A sliding window keeps the rate honest, which matters
 * where the limit protects something that costs real money: an SMS-sending
 * endpoint, a payment attempt, a public upload.
 *
 * One script, so the count and the decision cannot interleave with another
 * caller's.
 */
const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])

redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local used = redis.call('ZCARD', key)

if used + cost > limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retry = window
  if oldest[2] then
    retry = math.ceil((tonumber(oldest[2]) + window - now) / 1000)
  end
  return { 0, limit - used, retry }
end

for i = 1, cost do
  redis.call('ZADD', key, now, now .. '-' .. i .. '-' .. math.random())
end
redis.call('PEXPIRE', key, window)

return { 1, limit - used - cost, 0 }`;

export interface RateLimitOptions {
  /** Requests permitted per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** How much this request counts for. Default 1. */
  cost?: number;
}

export class RedisRateLimiter {
  constructor(
    private readonly client: Redis,
    private readonly namespace = 'ratelimit',
  ) {}

  /**
   * Consumes allowance for a key.
   *
   * The key should identify whatever is being limited — an address, an
   * account, a tenant, or a pair of them. Limiting only by address does not
   * stop a distributed attempt against one account; limiting only by account
   * does not stop one address enumerating many. Real endpoints usually need
   * both, checked separately.
   */
  async consume(key: string, options: RateLimitOptions): Promise<RateLimitResult> {
    const { limit, windowMs, cost = 1 } = options;

    const result = (await this.client.eval(
      SLIDING_WINDOW_SCRIPT,
      1,
      `${this.namespace}:${key}`,
      String(Date.now()),
      String(windowMs),
      String(limit),
      String(cost),
    )) as [number, number, number];

    return {
      allowed: result[0] === 1,
      remaining: Math.max(0, result[1]),
      retryAfter: result[2],
      limit,
    };
  }

  /** Reports the current state without consuming. */
  async peek(key: string, options: RateLimitOptions): Promise<RateLimitResult> {
    return this.consume(key, { ...options, cost: 0 });
  }

  /** Clears a key's history — for an operator lifting a block. */
  async reset(key: string): Promise<void> {
    await this.client.del(`${this.namespace}:${key}`);
  }
}
