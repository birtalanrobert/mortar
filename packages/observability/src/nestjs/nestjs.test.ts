import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { of, throwError } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { createLogger, createNoopLogger } from '../logger';
import { InMemoryMetrics } from '../metrics';
import type { Logger } from '../types';
import { LoggerModule, MORTAR_LOGGER, MORTAR_METRICS } from './logger.module';
import { NestLoggerAdapter } from './nest-logger.adapter';
import { LoggingInterceptor } from './logging.interceptor';

function capture(): { logger: Logger; lines: () => Record<string, unknown>[] } {
  const written: string[] = [];
  const destination = new Writable({
    write(chunk, _e, cb) {
      written.push(chunk.toString());
      cb();
    },
  });
  return {
    logger: createLogger({ serviceName: 't', level: 'trace', pretty: false, destination }),
    lines: () =>
      written
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

describe('LoggerModule', () => {
  it('provides a logger and metrics, and exports both', () => {
    const module = LoggerModule.forRoot({ serviceName: 'api', pretty: false });
    expect(module.providers).toHaveLength(module.exports?.length ?? 0);
    const tokens = (module.providers ?? []).map((p) => (p as { provide: symbol }).provide);
    expect(tokens).toContain(MORTAR_LOGGER);
    expect(tokens).toContain(MORTAR_METRICS);
  });

  /**
   * Built through a real container, not by inspecting the module's shape.
   *
   * Asserting on `module.providers` proves only that a provider was declared.
   * It cannot catch a class that is exported but never registered, or one
   * whose constructor Nest has no way to resolve — both of which happened
   * here, and both of which only surface in an application that tries to
   * resolve them.
   */
  it.each([
    ['forRoot', () => LoggerModule.forRoot({ serviceName: 'api', pretty: false })],
    [
      'forRootAsync',
      () =>
        LoggerModule.forRootAsync({ useFactory: () => ({ serviceName: 'api', pretty: false }) }),
    ],
    ['forRootWithLogger', () => LoggerModule.forRootWithLogger(createNoopLogger())],
  ])('resolves its helpers from the container when configured with %s', async (_name, build) => {
    const moduleRef = await Test.createTestingModule({ imports: [build()] }).compile();

    expect(moduleRef.get(NestLoggerAdapter)).toBeInstanceOf(NestLoggerAdapter);
    expect(moduleRef.get(LoggingInterceptor)).toBeInstanceOf(LoggingInterceptor);
  });

  it('gives the adapter the configured logger rather than a fresh one', async () => {
    const logger = createNoopLogger();
    const moduleRef = await Test.createTestingModule({
      imports: [LoggerModule.forRootWithLogger(logger)],
    }).compile();

    const spy = vi.spyOn(logger, 'info');
    moduleRef.get(NestLoggerAdapter).log('mapped route');

    expect(spy).toHaveBeenCalledWith('mapped route', expect.anything());
  });

  it('accepts a pre-built logger for tests', () => {
    const logger = createNoopLogger();
    const module = LoggerModule.forRootWithLogger(logger);
    const provider = (module.providers ?? []).find(
      (p) => (p as { provide: symbol }).provide === MORTAR_LOGGER,
    ) as { useValue: Logger };
    expect(provider.useValue).toBe(logger);
  });
});

describe('NestLoggerAdapter', () => {
  it('routes framework output into the structured stream', () => {
    const { logger, lines } = capture();
    const adapter = new NestLoggerAdapter(logger);
    adapter.log('Mapped {/bookings, GET} route', 'RouterExplorer');
    expect(lines()[0]).toMatchObject({
      level: 'info',
      msg: 'Mapped {/bookings, GET} route',
      context: 'RouterExplorer',
    });
  });

  it('recognises the stack string Nest passes to error()', () => {
    const { logger, lines } = capture();
    new NestLoggerAdapter(logger).error('Something failed', 'Error: x\n    at y');
    expect(lines()[0]?.stack).toContain('at y');
  });

  it('passes an Error through as an Error', () => {
    const { logger, lines } = capture();
    new NestLoggerAdapter(logger).error('failed', new Error('boom'));
    expect((lines()[0]?.err as Record<string, unknown>)?.message).toBe('boom');
  });

  it('maps every level', () => {
    const { logger, lines } = capture();
    const adapter = new NestLoggerAdapter(logger);
    adapter.warn('w');
    adapter.debug('d');
    adapter.verbose('v');
    adapter.fatal('f');
    expect(lines().map((l) => l.level)).toEqual(['warn', 'debug', 'trace', 'fatal']);
  });
});

describe('LoggingInterceptor', () => {
  function makeContext(overrides: Record<string, unknown> = {}) {
    const request = { method: 'GET', url: '/bookings/abc', route: { path: '/bookings/:id' } };
    const response = { statusCode: 200, ...overrides };
    return {
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    } as unknown as ExecutionContext;
  }

  it('logs one line on completion with duration and status', async () => {
    const { logger, lines } = capture();
    const metrics = new InMemoryMetrics();
    const interceptor = new LoggingInterceptor(logger, metrics);
    const next: CallHandler = { handle: () => of({ ok: true }) };

    await new Promise<void>((resolve) =>
      interceptor.intercept(makeContext(), next).subscribe({ complete: () => resolve() }),
    );

    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({
      level: 'info',
      method: 'GET',
      route: '/bookings/:id',
      statusCode: 200,
    });
  });

  it('records metrics keyed on the route pattern, not the concrete url', async () => {
    const metrics = new InMemoryMetrics();
    const interceptor = new LoggingInterceptor(createNoopLogger(), metrics);
    await new Promise<void>((resolve) =>
      interceptor
        .intercept(makeContext(), { handle: () => of(null) })
        .subscribe({ complete: () => resolve() }),
    );
    const labels = { method: 'GET', route: '/bookings/:id', status: '200' };
    expect(metrics.value('http_requests_total', labels)).toBe(1);
    expect(metrics.observations('http_request_duration_ms', labels)).toHaveLength(1);
  });

  it('warns on 4xx and errors on 5xx', async () => {
    const { logger, lines } = capture();
    const interceptor = new LoggingInterceptor(logger, new InMemoryMetrics());
    for (const statusCode of [404, 500]) {
      await new Promise<void>((resolve) =>
        interceptor
          .intercept(makeContext({ statusCode }), { handle: () => of(null) })
          .subscribe({ complete: () => resolve() }),
      );
    }
    expect(lines().map((l) => l.level)).toEqual(['warn', 'error']);
  });

  it('logs and rethrows a failing handler', async () => {
    const { logger, lines } = capture();
    const interceptor = new LoggingInterceptor(logger, new InMemoryMetrics());
    const failure = Object.assign(new Error('nope'), { status: 422 });

    await new Promise<void>((resolve) =>
      interceptor
        .intercept(makeContext(), { handle: () => throwError(() => failure) })
        .subscribe({ error: () => resolve() }),
    );

    expect(lines()[0]).toMatchObject({ level: 'error', statusCode: 422 });
  });

  it('ignores non-HTTP execution contexts', async () => {
    const logger = createNoopLogger();
    const spy = vi.spyOn(logger, 'info');
    const interceptor = new LoggingInterceptor(logger, new InMemoryMetrics());
    const context = { getType: () => 'rpc' } as unknown as ExecutionContext;
    await new Promise<void>((resolve) =>
      interceptor
        .intercept(context, { handle: () => of(1) })
        .subscribe({ complete: () => resolve() }),
    );
    expect(spy).not.toHaveBeenCalled();
  });
});
