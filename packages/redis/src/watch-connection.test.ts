import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { Writable } from 'node:stream';
import { createLogger, type Logger } from '@birtalanrobert/observability';
import type { Redis } from 'ioredis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRedis } from './connection';
import { watchConnection } from './watch-connection';

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

async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('The condition never held.');
    await new Promise((done) => setTimeout(done, 20));
  }
}

describe('a watched connection', () => {
  afterEach(() => vi.restoreAllMocks());

  /**
   * A real client against a port nothing listens on, retrying as it does in
   * production: ioredis printed each failed attempt to the console itself.
   */
  it('says an outage once, however often the client retries, and nothing to the console', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = createRedis({
      url: `redis://127.0.0.1:${await closedPort()}`,
      connectionName: 'app',
    });
    const { logger, lines } = capture();
    watchConnection(client, logger);
    let attempts = 0;
    client.on('error', () => attempts++);

    await until(() => attempts >= 3);
    client.disconnect();

    expect(lines()).toEqual([
      expect.objectContaining({
        level: 'error',
        msg: 'redis unreachable',
        connection: 'app',
        err: expect.objectContaining({ code: 'ECONNREFUSED' }),
      }),
    ]);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('says the end of an outage, and the next one', () => {
    const client = Object.assign(new EventEmitter(), {
      options: { connectionName: 'app-subscriber' },
    }) as unknown as Redis;
    const { logger, lines } = capture();
    watchConnection(client, logger);

    client.emit('ready');
    client.emit('error', new Error('connect ECONNREFUSED'));
    client.emit('error', new Error('connect ECONNREFUSED'));
    client.emit('ready');
    client.emit('ready');
    client.emit('error', new Error('WRONGPASS invalid username-password pair'));

    expect(lines().map((line) => [line.level, line.msg, line.connection])).toEqual([
      ['error', 'redis unreachable', 'app-subscriber'],
      ['info', 'redis reachable again', 'app-subscriber'],
      ['error', 'redis unreachable', 'app-subscriber'],
    ]);
    expect(lines()[1]?.unreachableForMs).toEqual(expect.any(Number));
  });
});
