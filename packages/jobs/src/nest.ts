import {
  Global,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import type { Logger } from '@birtalanrobert/observability';
import { MORTAR_LOGGER } from '@birtalanrobert/observability/nestjs';
import {
  RedisService,
  createQueueConnection,
  type CreateRedisOptions,
} from '@birtalanrobert/redis';
import type { Job } from 'bullmq';
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

@Global()
@Module({})
export class JobsModule implements OnApplicationShutdown {
  constructor(
    private readonly queues: JobQueues,
    private readonly workers: JobWorkers,
    private readonly scheduler: TaskScheduler,
  ) {}

  static forRoot(options: JobsModuleOptions): DynamicModule {
    // A connection of its own, never the application's client: BullMQ's
    // blocking commands would stall anything else sharing it.
    const connection = createQueueConnection({
      ...options.redis,
      connectionName: 'mortar-queue',
    });

    const providers: Provider[] = [
      {
        provide: JobQueues,
        useFactory: () => new JobQueues({ connection, prefix: options.prefix }),
      },
      {
        provide: JobWorkers,
        useFactory: (logger?: Logger) =>
          new JobWorkers({
            connection,
            prefix: options.prefix,
            concurrency: options.concurrency,
            logger,
            onDeadLetter: options.onDeadLetter,
          }),
        inject: [{ token: MORTAR_LOGGER, optional: true }],
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

  async onApplicationShutdown(): Promise<void> {
    // Workers first, so in-flight jobs finish before the queues they report to
    // are closed.
    this.scheduler.stop();
    await this.workers.close();
    await this.queues.close();
  }
}
