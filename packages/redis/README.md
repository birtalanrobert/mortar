# @birtalanrobert/redis

The Redis connection, plus caching and locking built on it.

## Using it in a NestJS application

```ts
import { RedisModule } from '@birtalanrobert/redis';

@Module({
  imports: [
    ConfigModule.forRoot({ schema: envSchema }),

    RedisModule.forRootAsync({
      inject: [ConfigModule.token()],
      useFactory: (config: AppConfig) => ({
        url: config.REDIS_URL,
        // Every key this service writes is prefixed, so two services sharing
        // one Redis cannot collide — and `FLUSHDB` in a test cannot reach
        // anything a developer has running.
        keyPrefix: config.REDIS_PREFIX,
      }),
    }),
  ],
})
export class AppModule {}
```

`@Global()`, so one registration is enough. Register it before anything that
caches, rate-limits or locks.

## Injecting it

```ts
import { RedisService } from '@birtalanrobert/redis';

@Injectable()
export class Thing {
  constructor(private readonly redis: RedisService) {}

  async work() {
    await this.redis.client.set('key', 'value', 'EX', 60);
  }
}
```

`redis.client` is the underlying `ioredis` instance for anything the helpers
below do not cover.

`RedisService` bundles four things so a consumer injects one dependency rather
than four; each is also usable on its own outside Nest. It also holds the
process's pub/sub connection, `redis.subscriber`, described below.

## Caching — `redis.cache`

```ts
const value = await redis.cache.getOrSet('templates:list', () => expensive(), {
  ttlMs: 300_000,
  tags: ['templates'],
});

// Later, when a template changes:
await redis.cache.invalidateTag('templates');
```

Reads through on a miss, writes the result, returns it. Tags exist because the
thing that invalidates a cache rarely knows every key it affects — editing one
template should not require listing every query that mentioned it.

## Locking — `redis.locks`

```ts
await redis.locks.withLock('sweep:reminders', async () => {
  // runs on one replica at a time
});
```

Used by the scheduler in `@birtalanrobert/jobs` so a fleet runs a scheduled task
once rather than once each — which, for anything that writes, is not merely
wasted work but wrong work.

`acquire` is the lower-level form for when the lock outlives one callback.

## Rate limiting — `redis.rateLimit`

```ts
const result = await redis.rateLimit.consume(`login:${ip}`, { limit: 10, windowMs: 300_000 });
if (!result.allowed) throw new RateLimitedError(result.retryAfter); // seconds
```

`peek` asks without consuming, for a route that wants to report a budget it is
not spending.

## Pub/sub — `redis.subscriber`

```ts
const broadcast = new RedisBroadcast(redis.client, redis.subscriber, 'holdfast:realtime');
await broadcast.listen(publisher);
```

The connection a process listens on. It is separate from `redis.client`,
because a connection that has subscribed may issue nothing else. There is one
per process, with the client's server, credentials and reconnection. It
connects on its first `SUBSCRIBE`, so a process that only sends can hand it to
`RedisBroadcast` without holding an idle connection. `ioredis` subscribes again
by itself after reconnecting.

It is closed with the application, together with the client. A subscriber
built beside the module is one that nothing quits, and it keeps the process
alive after `SIGTERM`. Publish on `redis.client`.

## Health

The connection registers a health indicator, so `/health/ready` reports Redis
without anything extra being wired up.
