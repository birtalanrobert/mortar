import type { ArgumentsHost } from '@nestjs/common';
import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { runInContext } from '@mortar/context';
import { createNoopLogger } from '@mortar/observability';
import { ConflictError, CrossTenantAccessError, RateLimitedError } from './errors';
import { MortarExceptionFilter, type ExceptionFilterOptions } from './exception.filter';

function makeHost(url = '/bookings/abc', method = 'GET') {
  const response = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    json(body: unknown) {
      this.body = body;
      return body;
    },
  };
  const host = {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => ({ url, originalUrl: url, method }),
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
  return { host, response };
}

function run(
  exception: unknown,
  options: ExceptionFilterOptions = {},
  logger = createNoopLogger(),
) {
  const { host, response } = makeHost();
  new MortarExceptionFilter(logger, options).catch(exception, host);
  return response;
}

describe('response shape', () => {
  it('serves a MortarError as problem+json', () => {
    const response = run(new ConflictError('Seat already sold'));
    expect(response.statusCode).toBe(409);
    expect(response.headers['Content-Type']).toBe('application/problem+json');
    expect(response.body).toMatchObject({ status: 409, code: 'conflict' });
  });

  it('maps a Nest exception into the same shape', () => {
    const response = run(new NotFoundException('nope'));
    expect(response.statusCode).toBe(404);
    expect(response.body).toMatchObject({ code: 'not_found' });
  });

  it('sets Retry-After for rate limiting', () => {
    const response = run(new RateLimitedError(45));
    expect(response.statusCode).toBe(429);
    expect(response.headers['Retry-After']).toBe('45');
  });

  it('includes the request path as instance', () => {
    expect(run(new ConflictError('x')).body).toMatchObject({ instance: '/bookings/abc' });
  });

  it('includes the request id so a user can quote it', () => {
    const { host, response } = makeHost();
    runInContext({ requestId: 'req-42' }, () =>
      new MortarExceptionFilter(createNoopLogger()).catch(new ConflictError('x'), host),
    );
    expect(response.body).toMatchObject({ requestId: 'req-42' });
  });
});

describe('never leaking internals', () => {
  it('returns a generic 500 for an unexpected error', () => {
    const response = run(new Error('connection to postgres://user:hunter2@db failed'));
    expect(response.statusCode).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain('hunter2');
    expect(JSON.stringify(response.body)).not.toContain('postgres://');
  });

  it('exposes detail only when explicitly configured', () => {
    const response = run(new Error('boom'), { exposeInternals: true });
    expect(response.body).toMatchObject({ detail: 'boom' });
  });

  it('still answers when a non-Error is thrown', () => {
    expect(run('a bare string').statusCode).toBe(500);
    expect(run(undefined).statusCode).toBe(500);
  });
});

describe('logging', () => {
  it('logs 5xx at error level with the exception attached', () => {
    const logger = createNoopLogger();
    const spy = vi.spyOn(logger, 'error');
    const failure = new Error('boom');
    run(failure, {}, logger);
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]?.[1]).toBe(failure);
  });

  it('logs ordinary 4xx at debug, so warnings stay meaningful', () => {
    const logger = createNoopLogger();
    const warn = vi.spyOn(logger, 'warn');
    const debug = vi.spyOn(logger, 'debug');
    run(new NotFoundException(), {}, logger);
    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledOnce();
  });

  it('logs cross-tenant access at warn, because it is a bug or an attack', () => {
    const logger = createNoopLogger();
    const spy = vi.spyOn(logger, 'warn');
    run(new CrossTenantAccessError(), {}, logger);
    expect(spy).toHaveBeenCalledWith('cross-tenant access blocked', expect.any(Object));
  });

  it('works without a logger at all', () => {
    const { host, response } = makeHost();
    expect(() =>
      new MortarExceptionFilter(undefined).catch(new ConflictError('x'), host),
    ).not.toThrow();
    expect(response.statusCode).toBe(409);
  });
});

describe('non-http contexts', () => {
  it('rethrows rather than pretending to handle an rpc failure', () => {
    const host = { getType: () => 'rpc' } as unknown as ArgumentsHost;
    const failure = new Error('rpc boom');
    expect(() => new MortarExceptionFilter().catch(failure, host)).toThrow(failure);
  });
});
