import {
  Global,
  Inject,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import type { AsyncModuleOptions } from '@birtalanrobert/context';
import type { Logger } from '@birtalanrobert/observability';
import { MORTAR_LOGGER } from '@birtalanrobert/observability/nestjs';
import type { Redis } from 'ioredis';
import { RedisCache, type CacheOptions } from './cache';
import { closeClient } from './close-client';
import { createRedis, type CreateRedisOptions } from './connection';
import { checkRedisHealth, type RedisHealth } from './health';
import { RedisLocks } from './lock';
import { RedisRateLimiter } from './rate-limit';
import { watchConnection } from './watch-connection';

export const MORTAR_REDIS = Symbol('MORTAR_REDIS');

/** Injects the shared ioredis client. */
export const InjectRedis = () => Inject(MORTAR_REDIS);

/**
 * The injectable face of this package.
 *
 * Bundles the primitives so a service injects one dependency rather than four,
 * while each remains usable on its own outside Nest.
 */
export class RedisService {
  readonly locks: RedisLocks;
  readonly cache: RedisCache;
  readonly rateLimit: RedisRateLimiter;
  private listening: Redis | null = null;

  /**
   * Given a logger, the client and the subscriber say an outage through it,
   * once, and its end ({@link watchConnection}); without one ioredis prints
   * every failed reconnection to the console itself.
   */
  constructor(
    readonly client: Redis,
    cacheOptions: CacheOptions = {},
    private readonly logger?: Logger,
  ) {
    this.locks = new RedisLocks(client);
    this.cache = new RedisCache(client, cacheOptions);
    this.rateLimit = new RedisRateLimiter(client);
    if (logger) watchConnection(client, logger);
  }

  /**
   * The connection this process listens on for pub/sub. It connects on its
   * first `SUBSCRIBE`, not when it is read.
   *
   * A second connection because a Redis connection that has subscribed may
   * issue nothing but subscriptions, so sharing `client` would break every
   * cache read and lock behind the first `SUBSCRIBE`. One per process, shared
   * by everything that listens, because each subscription is a channel on it
   * rather than a connection of its own.
   *
   * Owned here rather than by each feature that listens, for two reasons. The
   * rule that a service reaches Redis through `RedisService` holds for pub/sub
   * too, rather than each gateway building clients from a URL it re-reads.
   * And it is closed with the application: a subscriber opened beside this
   * module is one nothing quits, and it keeps a process alive after `SIGTERM`.
   *
   * Lazy because code that is handed the subscriber is not always code that
   * listens. `RedisBroadcast` takes it in its constructor, and a process that
   * only sends — a worker publishing into a gateway's backlog — builds one and
   * never calls `listen`. Connecting on read would give that process an idle
   * connection for its whole life.
   *
   * A copy of `client`'s options, so the same server, credentials and
   * reconnection. `ioredis` re-subscribes by itself after a reconnection.
   */
  get subscriber(): Redis {
    if (!this.listening) {
      this.listening = this.client.duplicate({
        connectionName: `${this.client.options.connectionName ?? 'mortar-app'}-subscriber`,
        lazyConnect: true,
      });
      // A duplicate takes the client's options and none of its listeners.
      if (this.logger) watchConnection(this.listening, this.logger);
    }
    return this.listening;
  }

  health(timeoutMs?: number): Promise<RedisHealth> {
    return checkRedisHealth(this.client, timeoutMs);
  }

  /**
   * Closes the client and, if one was handed out, the subscriber: each quit
   * when connected and disconnected otherwise ({@link closeClient}) — a
   * subscriber that never subscribed, whose `QUIT` would open the connection
   * it closes, or either while Redis is down.
   */
  async close(): Promise<void> {
    const subscriber = this.listening;
    this.listening = null;
    await Promise.all([closeClient(this.client), subscriber && closeClient(subscriber)]);
  }
}

export interface RedisModuleOptions extends CreateRedisOptions {
  cache?: CacheOptions;
}

@Global()
@Module({})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(RedisService) private readonly redis: RedisService) {}

  static forRoot(options: RedisModuleOptions): DynamicModule {
    const { cache, ...connection } = options;

    const providers: Provider[] = [
      {
        provide: MORTAR_REDIS,
        useFactory: () => createRedis({ connectionName: 'mortar-app', ...connection }),
      },
      {
        provide: RedisService,
        useFactory: (client: Redis, logger?: Logger) => new RedisService(client, cache, logger),
        inject: [MORTAR_REDIS, { token: MORTAR_LOGGER, optional: true }],
      },
    ];

    return { module: RedisModule, providers, exports: providers };
  }

  /** Configures from other providers — validated config, most often. */
  static forRootAsync(options: AsyncModuleOptions<RedisModuleOptions>): DynamicModule {
    const clientProvider: Provider = {
      provide: MORTAR_REDIS,
      useFactory: async (...args: never[]) => {
        const { cache: _cache, ...connection } = await options.useFactory(...args);
        return createRedis({ connectionName: 'mortar-app', ...connection });
      },
      inject: (options.inject ?? []) as never[],
    };

    const serviceProvider: Provider = {
      provide: RedisService,
      useFactory: async (client: Redis, logger: Logger | undefined, ...args: never[]) => {
        const { cache } = await options.useFactory(...args);
        return new RedisService(client, cache, logger);
      },
      inject: [
        MORTAR_REDIS,
        { token: MORTAR_LOGGER, optional: true },
        ...((options.inject ?? []) as never[]),
      ],
    };

    return {
      module: RedisModule,
      imports: (options.imports ?? []) as never[],
      providers: [clientProvider, serviceProvider],
      exports: [clientProvider, serviceProvider],
    };
  }

  /** Provides an existing client, for tests. */
  static forRootWithClient(client: Redis, cache?: CacheOptions): DynamicModule {
    const providers: Provider[] = [
      { provide: MORTAR_REDIS, useValue: client },
      { provide: RedisService, useValue: new RedisService(client, cache) },
    ];
    return { module: RedisModule, providers, exports: providers };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.redis.close();
  }
}
