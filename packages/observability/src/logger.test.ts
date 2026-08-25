import { Writable } from 'node:stream';
import { runInContext } from '@mortar/context';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLogger, createNoopLogger } from './logger';
import type { Logger } from './types';

/** Captures emitted lines as parsed JSON so assertions read naturally. */
function capture(): { logger: Logger; lines: () => Record<string, unknown>[] } {
  const written: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      written.push(chunk.toString());
      callback();
    },
  });
  const logger = createLogger({
    serviceName: 'test-service',
    level: 'trace',
    pretty: false,
    destination,
  });
  return {
    logger,
    lines: () =>
      written
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('structured output', () => {
  it('emits the service name and a readable level', () => {
    const { logger, lines } = capture();
    logger.info('hello');
    expect(lines()[0]).toMatchObject({
      service: 'test-service',
      level: 'info',
      msg: 'hello',
    });
  });

  it('emits an ISO timestamp rather than epoch milliseconds', () => {
    const { logger, lines } = capture();
    logger.info('hello');
    expect(String(lines()[0]?.time)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('attaches supplied fields', () => {
    const { logger, lines } = capture();
    logger.info('booking created', { bookingId: 'b1', seats: 4 });
    expect(lines()[0]).toMatchObject({ bookingId: 'b1', seats: 4 });
  });

  it('serialises an Error passed directly', () => {
    const { logger, lines } = capture();
    logger.error('failed', new Error('boom'));
    const line = lines()[0];
    expect((line?.err as Record<string, unknown>)?.message).toBe('boom');
    expect((line?.err as Record<string, unknown>)?.stack).toBeDefined();
  });

  it('accepts fields instead of an Error', () => {
    const { logger, lines } = capture();
    logger.error('failed', { reason: 'timeout' });
    expect(lines()[0]).toMatchObject({ reason: 'timeout' });
  });
});

describe('context binding', () => {
  it('merges the ambient request context into every line', () => {
    const { logger, lines } = capture();
    runInContext({ requestId: 'r1', correlationId: 'c1', tenantId: 't1', source: 'http' }, () =>
      logger.info('inside'),
    );
    expect(lines()[0]).toMatchObject({
      requestId: 'r1',
      correlationId: 'c1',
      tenantId: 't1',
      source: 'http',
    });
  });

  it('emits nothing contextual outside a request', () => {
    const { logger, lines } = capture();
    logger.info('outside');
    expect(lines()[0]?.requestId).toBeUndefined();
  });

  it('lets explicit fields win over context', () => {
    const { logger, lines } = capture();
    runInContext({ tenantId: 'from-context' }, () => logger.info('x', { tenantId: 'explicit' }));
    expect(lines()[0]?.tenantId).toBe('explicit');
  });

  it('carries context through child loggers', () => {
    const { logger, lines } = capture();
    const child = logger.child({ component: 'slot-engine' });
    runInContext({ tenantId: 't9' }, () => child.info('computed'));
    expect(lines()[0]).toMatchObject({ component: 'slot-engine', tenantId: 't9' });
  });
});

describe('redaction', () => {
  let captured: ReturnType<typeof capture>;
  beforeEach(() => {
    captured = capture();
  });

  it('redacts a top-level secret field', () => {
    captured.logger.info('login', { password: 'hunter2' });
    expect(captured.lines()[0]?.password).toBe('[redacted]');
  });

  it('redacts nested secrets, which is where they actually appear', () => {
    captured.logger.info('request', { body: { password: 'hunter2', email: 'a@b.c' } });
    const body = captured.lines()[0]?.body as Record<string, unknown>;
    expect(body.password).toBe('[redacted]');
    expect(body.email).toBe('a@b.c');
  });

  it('redacts authorization headers', () => {
    captured.logger.info('request', { headers: { authorization: 'Bearer abc' } });
    const headers = captured.lines()[0]?.headers as Record<string, unknown>;
    expect(headers.authorization).toBe('[redacted]');
  });

  it('never lets a secret through in the raw output', () => {
    captured.logger.info('payment', {
      card: { cardNumber: '4111111111111111', cvv: '123' },
    });
    const raw = JSON.stringify(captured.lines());
    expect(raw).not.toContain('4111111111111111');
    expect(raw).not.toContain('"123"');
  });
});

describe('level filtering', () => {
  it('suppresses lines below the configured level', () => {
    const written: string[] = [];
    const destination = new Writable({
      write(chunk, _e, cb) {
        written.push(chunk.toString());
        cb();
      },
    });
    const logger = createLogger({
      serviceName: 's',
      level: 'warn',
      pretty: false,
      destination,
    });
    logger.debug('ignored');
    logger.info('ignored');
    logger.warn('kept');
    expect(written.join('')).not.toContain('ignored');
    expect(written.join('')).toContain('kept');
    expect(logger.isLevelEnabled('debug')).toBe(false);
    expect(logger.isLevelEnabled('error')).toBe(true);
  });
});

describe('time', () => {
  it('logs a duration and returns the result', async () => {
    const { logger, lines } = capture();
    const result = await logger.time('slot computation', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return 42;
    });
    expect(result).toBe(42);
    expect(lines()[0]).toMatchObject({ outcome: 'ok' });
    expect(Number(lines()[0]?.durationMs)).toBeGreaterThan(0);
  });

  it('logs the duration on failure too, then rethrows', async () => {
    const { logger, lines } = capture();
    await expect(
      logger.time('failing operation', async () => {
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
    expect(lines()[0]).toMatchObject({ outcome: 'error', level: 'error' });
    expect(lines()[0]?.durationMs).toBeDefined();
  });
});

describe('noop logger', () => {
  it('discards everything but still runs timed operations', async () => {
    const logger = createNoopLogger();
    expect(() => logger.info('x')).not.toThrow();
    expect(logger.child({ a: 1 })).toBeDefined();
    await expect(logger.time('x', async () => 'value')).resolves.toBe('value');
  });
});
