import {
  Global,
  Inject,
  Module,
  Optional,
  type DynamicModule,
  type BeforeApplicationShutdown,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import type { AsyncModuleOptions } from '@birtalanrobert/context';
import type { Logger, Metrics } from '@birtalanrobert/observability';
import { MORTAR_LOGGER, MORTAR_METRICS } from '@birtalanrobert/observability/nestjs';
import {
  RedisService,
  closeClient,
  createQueueConnection,
  watchConnection,
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
export class JobsModule implements BeforeApplicationShutdown, OnApplicationShutdown {
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
      // socket outlives `app.close()` and the process never exits. Given a
      // logger, it says an outage once, and its end.
      {
        provide: MORTAR_QUEUE_CONNECTION,
        useFactory: (logger?: Logger) => {
          if (logger) watchConnection(connection, logger);
          return connection;
        },
        inject: [{ token: MORTAR_LOGGER, optional: true }],
      },
      {
        provide: JobQueues,
        useFactory: (logger?: Logger) =>
          new JobQueues({ connection, prefix: options.prefix, logger }),
        inject: [{ token: MORTAR_LOGGER, optional: true }],
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
        useFactory: async (logger: Logger | undefined, ...args: never[]) => {
          resolved.current = await options.useFactory(...args);
          const connection = createQueueConnection({
            ...resolved.current.redis,
            connectionName: 'mortar-queue',
          });
          if (logger) watchConnection(connection, logger);
          return connection;
        },
        inject: [{ token: MORTAR_LOGGER, optional: true }, ...((options.inject ?? []) as never[])],
      },
      {
        provide: JobQueues,
        useFactory: (connection: never, logger?: Logger) =>
          new JobQueues({ connection, prefix: resolved.current?.prefix, logger }),
        inject: [connectionToken, { token: MORTAR_LOGGER, optional: true }],
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

  /**
   * The scheduled tasks stopped, and their runs under way let finish, before
   * any connection closes: the application's database and Redis close on
   * shutdown, after every `beforeApplicationShutdown`.
   */
  async beforeApplicationShutdown(): Promise<void> {
    await this.scheduler.stop();
  }

  async onApplicationShutdown(): Promise<void> {
    // Workers first, so in-flight jobs finish before the queues they report to
    // are closed.
    await this.scheduler.stop();
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
     * Quit when connected, so in-flight commands are answered; disconnected
     * otherwise ({@link closeClient}) — a `QUIT` sent while Redis is down
     * waits behind what is already waiting, and this connection has no
     * command timeout to end it. A connection that goes as it is quit throws,
     * and there is nothing left to do about it at this point.
     */
    if (!this.connection) return;
    try {
      await closeClient(this.connection);
    } catch {
      this.connection.disconnect();
    }
  }
}
