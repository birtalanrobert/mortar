import { createServer } from 'node:net';
import { Writable } from 'node:stream';
import { createLogger, type Logger } from '@birtalanrobert/observability';
import { createQueueConnection, watchConnection } from '@birtalanrobert/redis';
import type { Redis } from 'ioredis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectionReady } from './connection-ready';
import { defineJob } from './job';
import { JobQueues } from './queue';
import { JobWorkers } from './worker';

/** A port nothing listens on: taken from the system, then let go. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as { port: number };
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

function capture(): { logger: Logger; lines: () => Record<string, unknown>[] } {
  const written: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      written.push(chunk.toString());
      callback();
    },
  });
  return {
    logger: createLogger({ serviceName: 't', level: 'trace', pretty: false, destination }),
    lines: () =>
      written
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

const ping = defineJob<{ at: number }>({ name: 'ping.send', queue: 'outage-test' });

/**
 * Redis down under a process that consumes and enqueues — a real queue
 * connection, its workers and its queue, against a port nothing listens on.
 * Each worker passed on every failed reconnection as an error, several a
 * second, and BullMQ waited for Redis before it let a worker close.
 */
describe('the queue while Redis is down', () => {
  let connection: Redis;

  afterEach(() => {
    connection.disconnect();
    vi.restoreAllMocks();
  });

  it('says it once, through the connection, and closes at once', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { logger, lines } = capture();
    connection = createQueueConnection({
      url: `redis://127.0.0.1:${await closedPort()}`,
      connectionName: 'mortar-queue',
    });
    watchConnection(connection, logger);
    const workers = new JobWorkers({ connection, logger });
    workers.register(ping, async () => undefined);
    const queues = new JobQueues({ connection, logger });
    void queues.enqueue(ping, { at: 1 }).catch(() => undefined);
    let attempts = 0;
    connection.on('error', () => attempts++);

    await vi.waitFor(() => expect(attempts).toBeGreaterThanOrEqual(3), { timeout: 5_000 });
    const started = Date.now();
    await workers.close();
    await queues.close();

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(lines().filter((line) => line.level === 'error')).toEqual([
      expect.objectContaining({ msg: 'redis unreachable', connection: 'mortar-queue' }),
    ]);
    expect(
      lines().some((line) => line.msg === 'job worker error while its connection is down'),
    ).toBe(true);
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe('connectionReady', () => {
  it('reads a client by its status, and options as connected', () => {
    expect(connectionReady({ status: 'ready' } as unknown as Redis)).toBe(true);
    expect(connectionReady({ status: 'reconnecting' } as unknown as Redis)).toBe(false);
    expect(connectionReady({ status: 'connecting' } as unknown as Redis)).toBe(false);
    expect(connectionReady({ host: 'localhost', port: 6379 })).toBe(true);
  });
});
