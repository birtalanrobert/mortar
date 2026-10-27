import type { Logger } from '@birtalanrobert/observability';
import type { Redis } from 'ioredis';

/**
 * Says a connection's outage once, and its end once.
 *
 * ioredis emits `error` at every failed attempt to reconnect — several a
 * second at first — and, with nobody listening, prints each to the console
 * itself, outside any log: sixty lines in under a minute from one API whose
 * Redis had stopped. Listening here takes that over. The first error since the
 * connection was last ready is logged with its cause — a refused connection, a
 * wrong password — and the rest of the outage is not; `ready` after it is
 * logged with how long the outage lasted.
 */
export function watchConnection(client: Redis, logger: Logger): void {
  const connection = client.options.connectionName ?? 'redis';
  let lostAt: number | null = null;

  client.on('error', (error: Error) => {
    if (lostAt !== null) return;
    lostAt = Date.now();
    logger.error('redis unreachable', error, { connection });
  });

  client.on('ready', () => {
    if (lostAt === null) return;
    logger.info('redis reachable again', { connection, unreachableForMs: Date.now() - lostAt });
    lostAt = null;
  });
}
