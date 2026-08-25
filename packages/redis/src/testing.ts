import { Redis } from 'ioredis';
import { buildRedisOptions } from './connection';

/**
 * Connection string for mortar's own test Redis.
 *
 * Port 3051 sits outside the 3100-4799 range the seventeen projects allocate
 * from, so mortar's tests can never touch a project's local data.
 */
export const TEST_REDIS_URL = process.env.MORTAR_TEST_REDIS_URL ?? 'redis://localhost:3051';

/** A client against the test instance, namespaced per suite. */
export function createTestRedis(namespace = 'test'): Redis {
  return new Redis(
    buildRedisOptions({
      url: TEST_REDIS_URL,
      keyPrefix: `${namespace}:${Math.random().toString(36).slice(2, 8)}`,
      connectionName: 'mortar-test',
    }),
  );
}

/** Removes every key this client's prefix owns. */
export async function flushTestRedis(client: Redis): Promise<void> {
  const prefix = (client.options.keyPrefix ?? '') + '*';
  // SCAN rather than KEYS: KEYS blocks the server, and even in tests that
  // habit escapes into production code by copy-paste.
  const stream = client.scanStream({ match: prefix, count: 500 });
  const keys: string[] = [];
  for await (const batch of stream) keys.push(...(batch as string[]));
  if (keys.length > 0) {
    // These come back with the prefix already applied, so use a raw client.
    await client.call('DEL', ...keys);
  }
}
