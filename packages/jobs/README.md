# @birtalanrobert/jobs

Background jobs on BullMQ: typed definitions, workers, scheduled tasks and a
forward-window scanner.

## Using it in a NestJS application

```ts
import { JobsModule } from '@birtalanrobert/jobs';

@Module({
  imports: [
    ConfigModule.forRoot({ schema: envSchema }),
    LoggerModule.forRootAsync({/* … */}),
    DatabaseModule.forRootAsync({/* … */}),
    RedisModule.forRootAsync({/* … */}),

    JobsModule.forRootAsync({
      inject: [ConfigModule.token(), AuditService],
      useFactory: (config: AppConfig, audit: AuditService) => ({
        redis: { url: config.REDIS_URL },
        prefix: config.QUEUE_PREFIX,
        concurrency: config.QUEUE_CONCURRENCY,
        /**
         * What happens when a job has exhausted every attempt. BullMQ keeps
         * the failed job, but keeping it is not the same as anybody knowing.
         */
        onDeadLetter: async (job, error) => {
          await audit.record({
            action: 'job.dead_lettered',
            entityType: 'job',
            entityId: String(job.id),
            metadata: { queue: job.queueName, error: error.message },
          });
        },
      }),
    }),
  ],
})
export class AppModule {}
```

`@Global()`. Register it after Redis, which it connects through.

## Defining a job

A definition is the shared vocabulary between whoever enqueues and whoever
runs — the queue, the name, the retry policy and the payload type in one place.
**Both sides import the same definition**; a copied contract eventually becomes
a different contract.

```ts
import { defineJob } from '@birtalanrobert/jobs';

export const sendReminder = defineJob<{ reminderId: string; tenantId: string }>({
  name: 'reminder.send',
  queue: 'notifications',
  // A stable id makes enqueuing idempotent: BullMQ ignores a second job with
  // an id it already holds. No colons — BullMQ reserves them as key separators.
  idFor: (payload) => `reminder-${payload.reminderId}`,
  options: {
    attempts: 5,
    // Exponential, not fixed: the usual reason a notification fails is that a
    // provider is briefly unwell, and a fixed interval is indistinguishable
    // from hammering it.
    backoff: { type: 'exponential', delay: 5_000 },
  },
});
```

## Enqueuing

```ts
constructor(private readonly queues: JobQueues) {}

await this.queues.enqueue(sendReminder, { reminderId, tenantId });
```

## Handling

```ts
@Injectable()
export class RemindersHandlers implements OnApplicationBootstrap {
  constructor(private readonly workers: JobWorkers) {}

  onApplicationBootstrap() {
    this.workers.register(sendReminder, async (payload) => {
      /* … */
    });
  }
}
```

The runner records `job_duration_ms`, `jobs_total` labelled by outcome, and
`jobs_dead_lettered_total` — in the runner rather than in each handler, because
those are properties of the runner and identical in every service.

## Scheduled tasks

```ts
this.scheduler.register({
  name: 'reminders.purge',
  intervalMs: 60 * 60 * 1000,
  run: async () => this.queues.enqueue(purgeReminders, { olderThan }),
  // Not on start: a rolling deploy restarts every replica within a minute, and
  // `runOnStart` would turn that into one sweep per replica.
  runOnStart: false,
});
```

`TaskScheduler` holds a distributed lock per run, so a fleet executes a task
once rather than once each. Keep the callback short — it enqueues rather than
doing the work, so the lock is held for milliseconds.

## The scanner

For work that comes due rather than work that is requested. A **forward
window** — "what falls due in the next few minutes" — scanned periodically,
instead of one scheduled job per item.

The difference matters at scale: a million reminders is a million timers under
the second design, and one query under this one. It also survives a deadline
moving, which a scheduled timer does not.

## Queues are concurrency pools

Give housekeeping its own queue. Maintenance must never sit behind a backlog of
notifications, and notifications must never wait behind a slow sweep.
