import { createServer } from 'node:net';
import { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { closeClient } from './close-client';
import { buildRedisOptions } from './connection';
import { RedisService } from './nest';

/** A port nothing listens on: taken from the system, then let go. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as { port: number };
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

/** Quitting a connected client is in `redis.integration.test.ts`, which has a Redis. */
describe('closing a client that is not connected', () => {
  it('disconnects one that never connected, without connecting it', async () => {
    const client = new Redis({
      ...buildRedisOptions({ url: `redis://127.0.0.1:${await closedPort()}` }),
      lazyConnect: true,
    });
    let errors = 0;
    client.on('error', () => errors++);

    await closeClient(client);

    expect(client.status).toBe('end');
    expect(errors).toBe(0);
  });

  /**
   * As an application stopped while Redis is down closes: its subscriber has
   * a subscription waiting, and a `QUIT` behind it waited for the command
   * timeout and failed the shutdown — five seconds, then exit code 1.
   */
  it('returns at once while Redis is down, though a command is waiting', async () => {
    const client = new Redis(buildRedisOptions({ url: `redis://127.0.0.1:${await closedPort()}` }));
    client.on('error', () => undefined);
    const redis = new RedisService(client);
    redis.subscriber.on('error', () => undefined);
    // Left to fail on its own timeout, as it would in the application.
    void redis.subscriber.subscribe('events').catch(() => undefined);
    await new Promise<void>((done) => client.once('reconnecting', () => done()));

    const started = Date.now();
    await redis.close();

    expect(Date.now() - started).toBeLessThan(100);
  });
});
