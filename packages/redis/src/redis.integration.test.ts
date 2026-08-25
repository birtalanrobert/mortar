import type { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { RedisCache } from './cache';
import { checkRedisHealth } from './health';
import { RedisLocks } from './lock';
import { RedisRateLimiter } from './rate-limit';
import { createTestRedis, flushTestRedis } from './testing';

const client: Redis = createTestRedis('redis-suite');

afterAll(async () => {
  await flushTestRedis(client);
  await client.quit();
});

beforeEach(async () => {
  await flushTestRedis(client);
});

describe('health', () => {
  it('reports up with latency and memory', async () => {
    const health = await checkRedisHealth(client);
    expect(health.status).toBe('up');
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    expect(health.memoryUsedBytes).toBeGreaterThan(0);
  });
});

describe('locks', () => {
  const locks = new RedisLocks(client);

  it('grants the lock to exactly one of many simultaneous callers', async () => {
    const attempts = await Promise.all(
      Array.from({ length: 10 }, () => locks.acquire('contended')),
    );
    expect(attempts.filter(Boolean)).toHaveLength(1);
  });

  it('releases so the next caller can take it', async () => {
    const first = await locks.acquire('sequential');
    expect(first).not.toBeNull();
    expect(await first!.release()).toBe(true);
    expect(await locks.acquire('sequential')).not.toBeNull();
  });

  it('will not release a lock held by someone else', async () => {
    // The reason release is a Lua script: a naive get-then-delete can remove a
    // lock that expired and was re-acquired between the two commands.
    const holder = await locks.acquire('owned', { ttlMs: 5000 });
    const impostor = new RedisLocks(client);
    const stolen = await impostor.acquire('owned');
    expect(stolen).toBeNull();
    expect(await holder!.release()).toBe(true);
  });

  it('expires on its own, so a dead holder cannot block forever', async () => {
    await locks.acquire('expiring', { ttlMs: 50 });
    expect(await locks.acquire('expiring')).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(await locks.acquire('expiring')).not.toBeNull();
  });

  it('extends while work is still running', async () => {
    const lock = await locks.acquire('extended', { ttlMs: 60 });
    expect(await lock!.extend(2000)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await locks.acquire('extended')).toBeNull();
  });

  it('cannot extend a lock already lost', async () => {
    const lock = await locks.acquire('lost', { ttlMs: 40 });
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(await lock!.extend(1000)).toBe(false);
  });

  it('waits for the lock when asked', async () => {
    const held = await locks.acquire('waited', { ttlMs: 80 });
    expect(held).not.toBeNull();
    const second = await locks.acquire('waited', { waitMs: 500, retryDelayMs: 20 });
    expect(second).not.toBeNull();
  });

  it('releases even when the work throws', async () => {
    await expect(
      locks.withLock('guarded', async () => {
        throw new Error('work failed');
      }),
    ).rejects.toThrow('work failed');
    expect(await locks.acquire('guarded')).not.toBeNull();
  });

  it('returns undefined rather than throwing when the lock is taken', async () => {
    // "Somebody else is already doing this" is the expected outcome for a
    // scheduled job on a scaled fleet, not a failure.
    await locks.acquire('busy', { ttlMs: 5000 });
    expect(await locks.withLock('busy', async () => 'ran')).toBeUndefined();
  });

  it('runs a scheduled job once across a fleet', async () => {
    let runs = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        locks.withLock('nightly-report', async () => {
          runs += 1;
        }),
      ),
    );
    expect(runs).toBe(1);
  });
});

describe('cache', () => {
  const cache = new RedisCache(client, { ttlMs: 60_000 });

  it('stores and reads structured values', async () => {
    await cache.set('order:1', { id: 1, total: 4200, lines: ['a', 'b'] });
    expect(await cache.get('order:1')).toEqual({ id: 1, total: 4200, lines: ['a', 'b'] });
  });

  it('misses cleanly for an unknown key', async () => {
    expect(await cache.get('nope')).toBeUndefined();
  });

  it('expires', async () => {
    await cache.set('brief', 'value', { ttlMs: 40 });
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(await cache.get('brief')).toBeUndefined();
  });

  it('computes only on a miss', async () => {
    let computed = 0;
    const compute = async () => {
      computed += 1;
      return 'value';
    };
    expect(await cache.getOrSet('lazy', compute)).toBe('value');
    expect(await cache.getOrSet('lazy', compute)).toBe('value');
    expect(computed).toBe(1);
  });

  it('invalidates by tag, which is how these caches are actually invalidated', async () => {
    // A price-list import invalidates every customer it affects; reconstructing
    // that key set at each call site is where staleness creeps in.
    await cache.set('price:cust-1', 100, { tags: ['pricelist:A'] });
    await cache.set('price:cust-2', 200, { tags: ['pricelist:A'] });
    await cache.set('price:cust-3', 300, { tags: ['pricelist:B'] });

    expect(await cache.invalidateTag('pricelist:A')).toBe(2);
    expect(await cache.get('price:cust-1')).toBeUndefined();
    expect(await cache.get('price:cust-2')).toBeUndefined();
    expect(await cache.get('price:cust-3')).toBe(300);
  });

  it('drops a value that will not parse rather than returning a miss forever', async () => {
    await client.set('cache:corrupt', 'not json');
    expect(await cache.get('corrupt')).toBeUndefined();
    expect(await client.get('cache:corrupt')).toBeNull();
  });

  it('deletes explicitly', async () => {
    await cache.set('a', 1);
    await cache.set('b', 2);
    expect(await cache.delete('a', 'b')).toBe(2);
  });
});

describe('rate limiting', () => {
  const limiter = new RedisRateLimiter(client);
  const policy = { limit: 3, windowMs: 1000 };

  it('permits up to the limit then refuses', async () => {
    for (let i = 0; i < 3; i++) {
      expect((await limiter.consume('ip:1.2.3.4', policy)).allowed).toBe(true);
    }
    const blocked = await limiter.consume('ip:1.2.3.4', policy);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
  });

  it('reports what is left', async () => {
    expect((await limiter.consume('k', policy)).remaining).toBe(2);
    expect((await limiter.consume('k', policy)).remaining).toBe(1);
  });

  it('keeps keys independent', async () => {
    for (let i = 0; i < 3; i++) await limiter.consume('a', policy);
    expect((await limiter.consume('b', policy)).allowed).toBe(true);
  });

  it('recovers once the window slides past', async () => {
    const brief = { limit: 2, windowMs: 100 };
    await limiter.consume('sliding', brief);
    await limiter.consume('sliding', brief);
    expect((await limiter.consume('sliding', brief)).allowed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 140));
    expect((await limiter.consume('sliding', brief)).allowed).toBe(true);
  });

  it('does not permit double the rate across a boundary', async () => {
    // The failure a fixed window has: spend the allowance at the end of one
    // window and the whole of the next immediately after.
    const brief = { limit: 5, windowMs: 300 };
    for (let i = 0; i < 5; i++) await limiter.consume('boundary', brief);
    await new Promise((resolve) => setTimeout(resolve, 160));

    let allowed = 0;
    for (let i = 0; i < 5; i++) {
      if ((await limiter.consume('boundary', brief)).allowed) allowed += 1;
    }
    expect(allowed).toBe(0);
  });

  it('supports a weighted cost, for expensive operations', async () => {
    expect((await limiter.consume('costly', { ...policy, cost: 3 })).allowed).toBe(true);
    expect((await limiter.consume('costly', policy)).allowed).toBe(false);
  });

  it('peeks without consuming', async () => {
    await limiter.consume('peeked', policy);
    expect((await limiter.peek('peeked', policy)).remaining).toBe(2);
    expect((await limiter.peek('peeked', policy)).remaining).toBe(2);
  });

  it('resets for an operator lifting a block', async () => {
    for (let i = 0; i < 3; i++) await limiter.consume('blocked', policy);
    await limiter.reset('blocked');
    expect((await limiter.consume('blocked', policy)).allowed).toBe(true);
  });

  it('is atomic under concurrent callers', async () => {
    // The count and the decision must not interleave, or the limit leaks.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => limiter.consume('stampede', { limit: 5, windowMs: 2000 })),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
  });
});
