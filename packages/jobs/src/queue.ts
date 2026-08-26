import { Queue, type ConnectionOptions, type JobsOptions } from 'bullmq';
import { DEFAULT_JOB_OPTIONS, type JobDefinition } from './job';
import { attachContext } from './propagation';

export interface QueueRegistryOptions {
  connection: ConnectionOptions;
  /** Namespaces every key, so two services can share one Redis safely. */
  prefix?: string;
  defaultJobOptions?: JobsOptions;
}

/**
 * Owns the queues and enqueues work.
 *
 * One `Queue` per name, reused: BullMQ opens a Redis connection per queue
 * instance, and constructing one per enqueue exhausts the connection limit
 * under any real load.
 */
export class JobQueues {
  private readonly queues = new Map<string, Queue>();

  constructor(private readonly options: QueueRegistryOptions) {}

  queue(name: string): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, {
        connection: this.options.connection,
        prefix: this.options.prefix ?? 'mortar',
        defaultJobOptions: { ...DEFAULT_JOB_OPTIONS, ...this.options.defaultJobOptions },
      });
      this.queues.set(name, queue);
    }
    return queue;
  }

  /**
   * Enqueues a job.
   *
   * The current request context travels with it, so the job's logs carry the
   * correlation id of whatever caused it. When the definition supplies
   * `idFor`, the id makes enqueueing idempotent — the same logical job
   * submitted twice runs once.
   */
  async enqueue<TPayload extends object>(
    definition: JobDefinition<TPayload>,
    payload: TPayload,
    options: JobsOptions = {},
  ): Promise<string | undefined> {
    const job = await this.queue(definition.queue).add(definition.name, attachContext(payload), {
      ...definition.options,
      ...options,
      ...(definition.idFor ? { jobId: jobIdFor(definition, payload) } : {}),
    });
    return job.id;
  }

  /** Enqueues for a future moment. */
  async schedule<TPayload extends object>(
    definition: JobDefinition<TPayload>,
    payload: TPayload,
    runAt: Date,
    options: JobsOptions = {},
  ): Promise<string | undefined> {
    const delay = Math.max(0, runAt.getTime() - Date.now());
    return this.enqueue(definition, payload, { ...options, delay });
  }

  /**
   * Enqueues many at once.
   *
   * One round trip rather than N. Matters wherever a scan produces a batch —
   * which is exactly what the window scanner does.
   */
  async enqueueMany<TPayload extends object>(
    definition: JobDefinition<TPayload>,
    payloads: TPayload[],
    options: JobsOptions = {},
  ): Promise<number> {
    if (payloads.length === 0) return 0;

    await this.queue(definition.queue).addBulk(
      payloads.map((payload) => ({
        name: definition.name,
        data: attachContext(payload),
        opts: {
          ...definition.options,
          ...options,
          ...(definition.idFor ? { jobId: jobIdFor(definition, payload) } : {}),
        },
      })),
    );
    return payloads.length;
  }

  /** Queue depth and health, for the metrics that matter operationally. */
  async stats(name: string): Promise<Record<string, number>> {
    return this.queue(name).getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    this.queues.clear();
  }
}

/**
 * Computes a job id and rejects one BullMQ cannot store.
 *
 * BullMQ uses `:` to separate segments of its own Redis keys, so a custom id
 * containing one is refused — with an error naming neither the job nor the
 * queue. Since the natural thing to write is `` `reminder:${id}` ``, that error
 * is reached often and explains nothing, and it surfaces at enqueue time,
 * which may be far from the definition that caused it.
 */
function jobIdFor<TPayload extends object>(
  definition: JobDefinition<TPayload>,
  payload: TPayload,
): string {
  const id = definition.idFor!(payload);
  if (id.includes(':')) {
    throw new Error(
      `Job '${definition.name}' produced the id '${id}', which BullMQ will not accept: ` +
        `a custom id cannot contain ':', because BullMQ uses it as a key separator. ` +
        `Use another separator — '-' is conventional.`,
    );
  }
  return id;
}
