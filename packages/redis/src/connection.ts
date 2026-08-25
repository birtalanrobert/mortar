import { Redis, type RedisOptions } from 'ioredis';

export interface CreateRedisOptions {
  url: string;
  /** Namespaces every key this client touches. */
  keyPrefix?: string;
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
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
    commandTimeout: commandTimeoutMs,
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
      enableOfflineQueue: true,
      connectionName: options.connectionName ?? 'mortar-queue',
      // BullMQ manages its own key namespacing through its `prefix` option;
      // an ioredis keyPrefix on top would corrupt the keys it computes.
      keyPrefix: undefined,
    }),
  );
}
