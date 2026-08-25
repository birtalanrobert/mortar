import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

export interface LockOptions {
  /** How long the lock survives without renewal. Default 30s. */
  ttlMs?: number;
  /** How long to keep trying to acquire. Default 0 — fail immediately. */
  waitMs?: number;
  /** Delay between attempts while waiting. Default 50ms. */
  retryDelayMs?: number;
}

export interface AcquiredLock {
  readonly key: string;
  /** Proves ownership; a lock is only released by whoever holds it. */
  readonly token: string;
  release(): Promise<boolean>;
  /** Extends the lock. Returns false if it was already lost. */
  extend(ttlMs: number): Promise<boolean>;
}

/**
 * Release, as a Lua script so the check and the delete are atomic.
 *
 * The naive `if (get(key) === token) del(key)` can delete a lock that expired
 * between the two commands and was re-acquired by somebody else — handing two
 * holders the same lock, which is the one thing a lock exists to prevent.
 */
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end`;

/** Extend, atomic for the same reason. */
const EXTEND_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
else
  return 0
end`;

/**
 * A single-instance distributed lock.
 *
 * Honest about what it is: correct for coordinating one Redis instance, which
 * is what every deployment in this catalogue runs. It is **not** Redlock and
 * makes no guarantee across a failover — if the holder is paused long enough
 * for the TTL to lapse, another holder can acquire. Work protected by a lock
 * should therefore still be idempotent, and anything requiring true mutual
 * exclusion belongs in a database constraint.
 */
export class RedisLocks {
  constructor(
    private readonly client: Redis,
    private readonly namespace = 'lock',
  ) {}

  private key(name: string): string {
    return `${this.namespace}:${name}`;
  }

  /** Acquires the lock, or returns null. */
  async acquire(name: string, options: LockOptions = {}): Promise<AcquiredLock | null> {
    const { ttlMs = 30_000, waitMs = 0, retryDelayMs = 50 } = options;
    const key = this.key(name);
    const token = randomUUID();
    const deadline = Date.now() + waitMs;

    for (;;) {
      const acquired = await this.client.set(key, token, 'PX', ttlMs, 'NX');
      if (acquired === 'OK') return this.handle(key, token);
      if (Date.now() >= deadline) return null;
      await sleep(Math.min(retryDelayMs, Math.max(0, deadline - Date.now())));
    }
  }

  private handle(key: string, token: string): AcquiredLock {
    return {
      key,
      token,
      release: async () => {
        const result = await this.client.eval(RELEASE_SCRIPT, 1, key, token);
        return result === 1;
      },
      extend: async (ttlMs: number) => {
        const result = await this.client.eval(EXTEND_SCRIPT, 1, key, token, String(ttlMs));
        return result === 1;
      },
    };
  }

  /**
   * Runs `work` while holding the lock, releasing it whatever happens.
   *
   * Returns `undefined` when the lock could not be taken — deliberately not an
   * error, because "somebody else is already doing this" is the expected
   * outcome for a scheduled job on a scaled fleet, not a failure.
   */
  async withLock<T>(
    name: string,
    work: () => Promise<T>,
    options: LockOptions = {},
  ): Promise<T | undefined> {
    const lock = await this.acquire(name, options);
    if (!lock) return undefined;
    try {
      return await work();
    } finally {
      await lock.release();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
