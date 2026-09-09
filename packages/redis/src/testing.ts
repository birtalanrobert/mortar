import { Redis } from 'ioredis';
import { buildRedisOptions } from './connection';

/**
 * Connection string for mortar's own test Redis.
 *
 * Port 3051 sits outside the 3100-4799 range the consuming services allocate
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

/**
 * Removes every key this client's prefix owns.
 *
 * **The prefix is stripped before deleting, and that is the whole of it.**
 * `SCAN` returns keys as Redis stores them — with the prefix already on — while
 * every write through this client has the prefix *added*. Passing the scanned
 * keys straight back deleted `prefix:prefix:thing`, which exists nowhere, so
 * this function quietly did nothing at all.
 *
 * Nothing failed. Suites that used it shared state between tests and passed
 * anyway until one of them counted something, which is the shape of bug a test
 * helper is worst at having.
 */
export async function flushTestRedis(client: Redis): Promise<void> {
  const prefix = client.options.keyPrefix ?? '';

  // SCAN rather than KEYS: KEYS blocks the server, and even in tests that
  // habit escapes into production code by copy-paste.
  const stream = client.scanStream({ match: `${prefix}*`, count: 500 });
  const keys: string[] = [];
  for await (const batch of stream) keys.push(...(batch as string[]));

  if (keys.length === 0) return;

  // Stripped, so `del` can put it back. Every other command through this client
  // works the same way, which is why it has to be done here rather than by
  // reaching for a second connection.
  await client.del(...keys.map((key) => key.slice(prefix.length)));
}
