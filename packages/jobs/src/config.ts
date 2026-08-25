import { envDuration, envInt, envString, envUrl, z } from '@birtalanrobert/config';

/** The Redis variables the queue needs. */
export const jobsEnvSchema = z.object({
  REDIS_URL: envUrl(),
  /** Namespaces every key, so two services can share one Redis safely. */
  QUEUE_PREFIX: envString('mortar'),
  /** Jobs processed concurrently per worker process. */
  QUEUE_CONCURRENCY: envInt(5),
  /** How long a completed job is kept, for inspection after the fact. */
  QUEUE_KEEP_COMPLETED: envDuration(24 * 60 * 60 * 1000),
  /** How long a permanently failed job is kept. Longer: somebody must look. */
  QUEUE_KEEP_FAILED: envDuration(7 * 24 * 60 * 60 * 1000),
});

export type JobsEnv = z.infer<typeof jobsEnvSchema>;
