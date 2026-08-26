import type { JobsOptions } from 'bullmq';

/**
 * A typed job definition.
 *
 * Name and payload type are declared together, once, so that enqueueing and
 * handling cannot drift apart — the failure that otherwise shows up as a
 * handler reading `job.data.bookingId` from a payload that says `booking_id`.
 */
export interface JobDefinition<TPayload> {
  /** Queue-unique name, conventionally `resource.action`. */
  readonly name: string;
  /** Queue this job runs on. Several job types may share a queue. */
  readonly queue: string;
  /** Default options, overridable per enqueue. */
  readonly options?: JobsOptions;
  /**
   * Derives a stable id from the payload.
   *
   * Supplying this makes enqueueing idempotent: BullMQ refuses a duplicate id,
   * so the same logical job enqueued twice runs once. Essential for anything
   * triggered by a webhook or a user action that can be repeated.
   */
  /**
   * A stable id per logical job, which is what makes enqueuing idempotent:
   * BullMQ ignores a second job carrying an id it already holds.
   *
   * Must not contain `:` — BullMQ uses it as a key separator and refuses the
   * job. Use `-`.
   */
  readonly idFor?: (payload: TPayload) => string;
}

/** Declares a job. The payload type is inferred at both ends from this. */
export function defineJob<TPayload>(definition: JobDefinition<TPayload>): JobDefinition<TPayload> {
  return definition;
}

/** Extracts the payload type from a definition. */
export type PayloadOf<T> = T extends JobDefinition<infer P> ? P : never;

/**
 * Retry defaults.
 *
 * Exponential from one second, five attempts — roughly sixteen seconds of
 * total delay. Long enough to ride out a restart or a brief network fault,
 * short enough that a genuinely broken job reaches the dead-letter queue while
 * somebody is still awake to notice.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
  // Failures are kept far longer, and by count as well as age: the whole point
  // is that a human reads them.
  removeOnFail: { age: 7 * 24 * 60 * 60 },
};
