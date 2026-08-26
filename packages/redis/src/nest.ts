import {
  Global,
  Inject,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import type { AsyncModuleOptions } from '@birtalanrobert/context';
import type { Redis } from 'ioredis';
import { RedisCache, type CacheOptions } from './cache';
import { createRedis, type CreateRedisOptions } from './connection';
import { checkRedisHealth, type RedisHealth } from './health';
import { RedisLocks } from './lock';
import { RedisRateLimiter } from './rate-limit';

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

  constructor(
    readonly client: Redis,
    cacheOptions: CacheOptions = {},
  ) {
    this.locks = new RedisLocks(client);
    this.cache = new RedisCache(client, cacheOptions);
    this.rateLimit = new RedisRateLimiter(client);
  }

  health(timeoutMs?: number): Promise<RedisHealth> {
    return checkRedisHealth(this.client, timeoutMs);
  }
}

export interface RedisModuleOptions extends CreateRedisOptions {
  cache?: CacheOptions;
}

@Global()
@Module({})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(MORTAR_REDIS) private readonly client: Redis) {}

  static forRoot(options: RedisModuleOptions): DynamicModule {
    const { cache, ...connection } = options;

    const providers: Provider[] = [
      {
        provide: MORTAR_REDIS,
        useFactory: () => createRedis({ connectionName: 'mortar-app', ...connection }),
      },
      {
        provide: RedisService,
        useFactory: (client: Redis) => new RedisService(client, cache),
        inject: [MORTAR_REDIS],
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
      useFactory: async (client: Redis, ...args: never[]) => {
        const { cache } = await options.useFactory(...args);
        return new RedisService(client, cache);
      },
      inject: [MORTAR_REDIS, ...((options.inject ?? []) as never[])],
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
    await this.client.quit();
  }
}
