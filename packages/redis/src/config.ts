import { envBoolean, envDuration, envInt, envString, envUrl, z } from '@birtalanrobert/config';

export const redisEnvSchema = z.object({
  REDIS_URL: envUrl(),
  /**
   * Namespaces every key.
   *
   * Two services sharing one Redis is normal, and without a prefix a `FLUSHDB`
   * or a key collision from one takes the other with it.
   */
  REDIS_PREFIX: envString('mortar'),
  REDIS_CONNECT_TIMEOUT: envDuration(10_000),
  REDIS_COMMAND_TIMEOUT: envDuration(5_000),
  /** Retain the connection through a failover rather than erroring. */
  REDIS_MAX_RETRIES: envInt(10),
  REDIS_TLS: envBoolean(false),
});

export type RedisEnv = z.infer<typeof redisEnvSchema>;
