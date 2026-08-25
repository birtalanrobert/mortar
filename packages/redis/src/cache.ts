import type { Redis } from 'ioredis';

export interface CacheOptions {
  /** Default lifetime for entries. */
  ttlMs?: number;
  namespace?: string;
}

/**
 * A namespaced cache with tag-based invalidation.
 *
 * Tags exist because the caches in this catalogue are invalidated by *event*
 * rather than by key: a price-list import invalidates every customer affected
 * by it, a booking invalidates every availability window it touches. Without
 * tags each caller has to reconstruct the key set that a change affects, and
 * the reconstruction is where staleness creeps in.
 */
export class RedisCache {
  private readonly ttlMs: number;
  private readonly namespace: string;

  constructor(
    private readonly client: Redis,
    options: CacheOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? 5 * 60 * 1000;
    this.namespace = options.namespace ?? 'cache';
  }

  private key(key: string): string {
    return `${this.namespace}:${key}`;
  }

  private tagKey(tag: string): string {
    return `${this.namespace}:tag:${tag}`;
  }

  async get<T>(key: string): Promise<T | undefined> {
    const raw = await this.client.get(this.key(key));
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // A value that will not parse is worse than a miss, because it will
      // never parse: drop it so the next read repopulates.
      await this.client.del(this.key(key));
      return undefined;
    }
  }

  async set<T>(
    key: string,
    value: T,
    options: { ttlMs?: number; tags?: string[] } = {},
  ): Promise<void> {
    const ttl = options.ttlMs ?? this.ttlMs;
    const pipeline = this.client.pipeline();
    pipeline.set(this.key(key), JSON.stringify(value), 'PX', ttl);

    for (const tag of options.tags ?? []) {
      pipeline.sadd(this.tagKey(tag), key);
      // The tag set outlives its members, or invalidation would miss entries
      // whose tag set expired first.
      pipeline.pexpire(this.tagKey(tag), ttl * 2);
    }

    await pipeline.exec();
  }

  /**
   * Returns the cached value, computing and storing it on a miss.
   *
   * Note this does **not** guard against a stampede: several callers missing
   * at once will all compute. That is the right trade for these workloads —
   * the computations are cheap enough that a lock would cost more than the
   * duplicate work, and a lock introduces a failure mode where one slow
   * computation blocks every reader.
   */
  async getOrSet<T>(
    key: string,
    compute: () => Promise<T>,
    options: { ttlMs?: number; tags?: string[] } = {},
  ): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== undefined) return cached;

    const value = await compute();
    await this.set(key, value, options);
    return value;
  }

  async delete(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return this.client.del(...keys.map((key) => this.key(key)));
  }

  /** Invalidates every entry carrying a tag. */
  async invalidateTag(tag: string): Promise<number> {
    const members = await this.client.smembers(this.tagKey(tag));
    if (members.length === 0) return 0;

    const pipeline = this.client.pipeline();
    for (const member of members) pipeline.del(this.key(member));
    pipeline.del(this.tagKey(tag));
    await pipeline.exec();
    return members.length;
  }

  async invalidateTags(...tags: string[]): Promise<number> {
    let total = 0;
    for (const tag of tags) total += await this.invalidateTag(tag);
    return total;
  }
}
