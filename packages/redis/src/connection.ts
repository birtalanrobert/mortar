import { Redis, type RedisOptions } from 'ioredis';

export interface CreateRedisOptions {
  url: string;
  /** Namespaces every key this client touches. */
  keyPrefix?: string;
  connectTimeoutMs?: number;
  /**
   * How long a single command may take before it is abandoned.
   *
   * `null` disables it, which is required for any connection issuing blocking
   * reads — see `createQueueConnection`.
   */
  commandTimeoutMs?: number | null;
  maxRetriesPerRequest?: number | null;
  tls?: boolean;
  /** Shown in `CLIENT LIST`, which is how you find a misbehaving connection. */
  connectionName?: string;
  /**
   * Queue commands issued before the connection is ready rather than failing
   * them. On for application clients; off for health checks, which should
   * report a connection problem rather than wait for it.
   */
  enableOfflineQueue?: boolean;
}

export function buildRedisOptions(options: CreateRedisOptions): RedisOptions {
  const {
    url,
    keyPrefix,
    connectTimeoutMs = 10_000,
    commandTimeoutMs = 5_000,
    maxRetriesPerRequest = 10,
    tls = false,
    connectionName,
    enableOfflineQueue = true,
  } = options;

  const parsed = new URL(url);

  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    db: parsed.pathname && parsed.pathname !== '/' ? Number(parsed.pathname.slice(1)) : 0,
    keyPrefix: keyPrefix ? `${keyPrefix}:` : undefined,
    connectTimeout: connectTimeoutMs,
    // `undefined` rather than a number when disabled: ioredis treats any
    // number as a deadline, and there is no "no timeout" number.
    commandTimeout: commandTimeoutMs ?? undefined,
    maxRetriesPerRequest,
    enableOfflineQueue,
    connectionName,
    tls: tls ? {} : undefined,
    // Exponential with a ceiling: a Redis restart should reconnect quickly,
    // and a longer outage should not become a reconnect storm.
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
    // Reconnect rather than fail when a replica is promoted mid-command.
    reconnectOnError: (error) => error.message.includes('READONLY'),
  };
}

/** Creates a client. Connects lazily on first command. */
export function createRedis(options: CreateRedisOptions): Redis {
  return new Redis(buildRedisOptions(options));
}

/**
 * Creates a connection for BullMQ.
 *
 * **Never share the application's client with BullMQ.** BullMQ issues blocking
 * commands (`BRPOPLPUSH` and friends) that occupy a connection for seconds at
 * a time; anything else using that client would stall behind them. It also
 * requires `maxRetriesPerRequest: null`, because a blocking read must not be
 * abandoned as a timeout.
 */
export function createQueueConnection(options: CreateRedisOptions): Redis {
  return new Redis(
    buildRedisOptions({
      ...options,
      maxRetriesPerRequest: null,
      /*
       * No command timeout, for the same reason as `maxRetriesPerRequest`.
       *
       * A queue consumer waits for work with blocking reads — `BZPOPMIN` and
       * friends — which are *designed* to sit there for longer than any
       * sensible command deadline. With a timeout applied, every idle wait
       * fails on schedule: a worker with nothing to do logs an error every few
       * seconds, for ever, and the noise buries the failures that matter.
       *
       * Jobs still run, which is what makes this so easy to miss — it looks
       * like a broken Redis rather than a misconfigured client.
       */
      commandTimeoutMs: null,
      enableOfflineQueue: true,
      connectionName: options.connectionName ?? 'mortar-queue',
      // BullMQ manages its own key namespacing through its `prefix` option;
      // an ioredis keyPrefix on top would corrupt the keys it computes.
      keyPrefix: undefined,
    }),
  );
}
