import {
  Global,
  Inject,
  Module,
  Optional,
  type DynamicModule,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import type { AsyncModuleOptions } from '@birtalanrobert/context';
import type { Logger, Metrics } from '@birtalanrobert/observability';
import { MORTAR_LOGGER, MORTAR_METRICS } from '@birtalanrobert/observability/nestjs';
import {
  RedisService,
  createQueueConnection,
  type CreateRedisOptions,
} from '@birtalanrobert/redis';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { JobQueues } from './queue';
import { TaskScheduler } from './scheduler';
import { JobWorkers } from './worker';

export interface JobsModuleOptions {
  /** Connection settings for the queue's own Redis connection. */
  redis: CreateRedisOptions;
  prefix?: string;
  concurrency?: number;
  /** Called when a job exhausts every attempt. Alert from here. */
  onDeadLetter?: (job: Job, error: Error) => void | Promise<void>;
}

/**
 * The queue's own Redis connection.
 *
 * Exported so the module can close what it opened. BullMQ closes connections it
 * creates and leaves alone the ones it is handed — which is correct of it, and
 * means whoever supplied this one is responsible for it.
 */
export const MORTAR_QUEUE_CONNECTION = Symbol('MORTAR_QUEUE_CONNECTION');

@Global()
@Module({})
export class JobsModule implements OnApplicationShutdown {
  constructor(
    private readonly queues: JobQueues,
    private readonly workers: JobWorkers,
    private readonly scheduler: TaskScheduler,
    @Optional()
    @Inject(MORTAR_QUEUE_CONNECTION)
    private readonly connection?: Redis,
  ) {}

  static forRoot(options: JobsModuleOptions): DynamicModule {
    // A connection of its own, never the application's client: BullMQ's
    // blocking commands would stall anything else sharing it.
    const connection = createQueueConnection({
      ...options.redis,
      connectionName: 'mortar-queue',
    });

    const providers: Provider[] = [
      // Provided so `onApplicationShutdown` can close it. Without this the
      // socket outlives `app.close()` and the process never exits.
      { provide: MORTAR_QUEUE_CONNECTION, useValue: connection },
      {
        provide: JobQueues,
        useFactory: () => new JobQueues({ connection, prefix: options.prefix }),
      },
      {
        provide: JobWorkers,
        useFactory: (logger?: Logger, metrics?: Metrics) =>
          new JobWorkers({
            connection,
            prefix: options.prefix,
            concurrency: options.concurrency,
            logger,
            metrics,
            onDeadLetter: options.onDeadLetter,
          }),
        inject: [
          { token: MORTAR_LOGGER, optional: true },
          { token: MORTAR_METRICS, optional: true },
        ],
      },
      {
        provide: TaskScheduler,
        useFactory: (redis: RedisService, logger?: Logger) =>
          new TaskScheduler(redis.locks, logger),
        inject: [RedisService, { token: MORTAR_LOGGER, optional: true }],
      },
    ];

    return {
      module: JobsModule,
      providers,
      exports: [JobQueues, JobWorkers, TaskScheduler],
    };
  }

  /** Configures from other providers — validated config, most often. */
  static forRootAsync(options: AsyncModuleOptions<JobsModuleOptions>): DynamicModule {
    const resolved = { current: undefined as JobsModuleOptions | undefined };
    // The exported token rather than a local symbol, so the module's own
    // constructor can be given the connection it has to close.
    const connectionToken = MORTAR_QUEUE_CONNECTION;

    const providers: Provider[] = [
      {
        provide: connectionToken,
        useFactory: async (...args: never[]) => {
          resolved.current = await options.useFactory(...args);
          return createQueueConnection({
            ...resolved.current.redis,
            connectionName: 'mortar-queue',
          });
        },
        inject: (options.inject ?? []) as never[],
      },
      {
        provide: JobQueues,
        useFactory: (connection: never) =>
          new JobQueues({ connection, prefix: resolved.current?.prefix }),
        inject: [connectionToken],
      },
      {
        provide: JobWorkers,
        useFactory: (connection: never, logger?: Logger, metrics?: Metrics) =>
          new JobWorkers({
            connection,
            prefix: resolved.current?.prefix,
            concurrency: resolved.current?.concurrency,
            logger,
            metrics,
            onDeadLetter: resolved.current?.onDeadLetter,
          }),
        inject: [
          connectionToken,
          { token: MORTAR_LOGGER, optional: true },
          { token: MORTAR_METRICS, optional: true },
        ],
      },
      {
        provide: TaskScheduler,
        useFactory: (redis: RedisService, logger?: Logger) =>
          new TaskScheduler(redis.locks, logger),
        inject: [RedisService, { token: MORTAR_LOGGER, optional: true }],
      },
    ];

    return {
      module: JobsModule,
      imports: (options.imports ?? []) as never[],
      providers,
      exports: [JobQueues, JobWorkers, TaskScheduler],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    // Workers first, so in-flight jobs finish before the queues they report to
    // are closed.
    this.scheduler.stop();
    await this.workers.close();
    await this.queues.close();

    /*
     * Last, and it is the reason a process can exit at all.
     *
     * BullMQ closes connections it created and leaves the ones it was handed —
     * correctly, since it does not own them. This module hands it one, so this
     * module closes it. Without this an application that has finished its work
     * and called `app.close()` sits there with an open socket for ever: a seed
     * script that never returns, and a deployment that hangs waiting for it.
     *
     * `quit` waits for in-flight commands; a connection already gone throws,
     * and there is nothing left to do about it at this point.
     */
    try {
      await this.connection?.quit();
    } catch {
      this.connection?.disconnect();
    }
  }
}
