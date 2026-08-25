import { Worker, type ConnectionOptions, type Job, type WorkerOptions } from 'bullmq';
import { createNoopLogger, type Logger } from '@mortar/observability';
import type { JobDefinition } from './job';
import { detachContext, runWithJobContext, type WithContext } from './propagation';

export type JobHandler<TPayload> = (payload: TPayload, job: Job) => Promise<void>;

export interface WorkerRegistryOptions {
  connection: ConnectionOptions;
  prefix?: string;
  concurrency?: number;
  logger?: Logger;
  /**
   * Called when a job exhausts every attempt.
   *
   * The dead-letter hook. BullMQ keeps the failed job, but keeping it is not
   * the same as anybody knowing — so this is where an alert, a support ticket
   * or a compensating action belongs.
   */
  onDeadLetter?: (job: Job, error: Error) => void | Promise<void>;
}

/**
 * Runs job handlers.
 *
 * Every handler is wrapped so that four things are true without the handler
 * having to arrange them: it runs inside the enqueuing request's context,
 * its duration and outcome are logged, a failure on the final attempt reaches
 * the dead-letter hook, and a thrown non-Error still becomes a real Error.
 */
export class JobWorkers {
  private readonly workers = new Map<string, Worker>();
  private readonly handlers = new Map<string, JobHandler<never>>();
  private readonly logger: Logger;

  constructor(private readonly options: WorkerRegistryOptions) {
    this.logger = options.logger ?? createNoopLogger();
  }

  /**
   * Registers a handler.
   *
   * Several job types may share a queue; the worker dispatches on job name, so
   * a queue is a concurrency pool rather than a job type.
   */
  register<TPayload extends object>(
    definition: JobDefinition<TPayload>,
    handler: JobHandler<TPayload>,
  ): this {
    const key = `${definition.queue}:${definition.name}`;
    if (this.handlers.has(key)) {
      throw new Error(`A handler for '${key}' is already registered.`);
    }
    this.handlers.set(key, handler as JobHandler<never>);
    this.ensureWorker(definition.queue, definition.options?.attempts);
    return this;
  }

  private ensureWorker(queueName: string, _attempts?: number): void {
    if (this.workers.has(queueName)) return;

    const workerOptions: WorkerOptions = {
      connection: this.options.connection,
      prefix: this.options.prefix ?? 'mortar',
      concurrency: this.options.concurrency ?? 5,
    };

    const worker = new Worker(
      queueName,
      async (job: Job) => this.process(queueName, job),
      workerOptions,
    );

    worker.on('failed', (job, error) => {
      if (!job) return;
      const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
      if (exhausted) void this.deadLetter(job, error);
    });

    worker.on('error', (error) => {
      // A worker-level error is the connection or the runtime, not a job —
      // silence here means a worker that has quietly stopped consuming.
      this.logger.error('job worker error', error, { queue: queueName });
    });

    this.workers.set(queueName, worker);
  }

  private async process(queueName: string, job: Job): Promise<void> {
    const key = `${queueName}:${job.name}`;
    const handler = this.handlers.get(key);

    if (!handler) {
      // Deliberately fatal: a job with no handler means a deploy removed the
      // handler while work was still queued, and silently dropping it loses
      // the work with no trace.
      throw new Error(`No handler registered for job '${key}'.`);
    }

    const { payload, context } = detachContext(job.data as WithContext<object>);
    const startedAt = Date.now();

    return runWithJobContext(context, job.name, async () => {
      this.logger.debug('job started', { queue: queueName, job: job.name, jobId: job.id });
      try {
        await (handler as JobHandler<object>)(payload, job);
        this.logger.info('job completed', {
          queue: queueName,
          job: job.name,
          jobId: job.id,
          durationMs: Date.now() - startedAt,
        });
      } catch (thrown) {
        // A handler throwing a string would otherwise reach BullMQ's retry
        // logic without a stack, making the failure undiagnosable.
        const error = thrown instanceof Error ? thrown : new Error(String(thrown));
        this.logger.warn('job failed', {
          queue: queueName,
          job: job.name,
          jobId: job.id,
          attempt: job.attemptsMade + 1,
          maxAttempts: job.opts.attempts ?? 1,
          durationMs: Date.now() - startedAt,
          error: error.message,
        });
        throw error;
      }
    });
  }

  private async deadLetter(job: Job, error: Error): Promise<void> {
    this.logger.error('job exhausted every attempt', error, {
      queue: job.queueName,
      job: job.name,
      jobId: job.id,
      attempts: job.attemptsMade,
    });
    try {
      await this.options.onDeadLetter?.(job, error);
    } catch (hookError) {
      this.logger.error('dead-letter hook itself failed', hookError, { jobId: job.id });
    }
  }

  /** Stops consuming, letting in-flight jobs finish first. */
  async close(): Promise<void> {
    await Promise.all([...this.workers.values()].map((worker) => worker.close()));
    this.workers.clear();
  }
}
