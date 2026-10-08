import { BadRequestException, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ConflictError, RateLimitedError } from './errors';
import { toProblemDetails } from './serialize';

describe('MortarError', () => {
  it('serializes directly', () => {
    const problem = toProblemDetails(new ConflictError('Seat taken'), { requestId: 'r1' });
    expect(problem).toMatchObject({ status: 409, code: 'conflict', detail: 'Seat taken' });
  });
});

describe('Nest HttpException', () => {
  it('maps to the same problem shape as a MortarError', () => {
    const problem = toProblemDetails(new NotFoundException('No such booking'));
    expect(problem).toMatchObject({
      status: 404,
      code: 'not_found',
      title: 'Not found',
      detail: 'No such booking',
    });
  });

  it('maps the ValidationPipe message array into field errors', () => {
    const exception = new BadRequestException({
      statusCode: 400,
      message: ['email must be an email', 'name should not be empty'],
      error: 'Bad Request',
    });
    const problem = toProblemDetails(exception);
    expect(problem.status).toBe(400);
    expect(problem.code).toBe('validation_failed');
    expect(problem.errors).toEqual([
      { field: 'email', message: 'email must be an email' },
      { field: 'name', message: 'name should not be empty' },
    ]);
  });

  it('handles a string response body', () => {
    const problem = toProblemDetails(new HttpException('Teapot', HttpStatus.I_AM_A_TEAPOT));
    expect(problem.status).toBe(418);
    expect(problem.detail).toBe('Teapot');
  });

  it('falls back sensibly for an unmapped status', () => {
    const problem = toProblemDetails(new HttpException('odd', 599));
    expect(problem.status).toBe(599);
    expect(problem.code).toBe('internal_error');
  });
});

describe('an error the HTTP stack raised about the client’s request', () => {
  /** What body-parser raises through `http-errors`: its status, and its word that the message is the client's. */
  const raised = (error: Error, status: number, type: string) =>
    Object.assign(error, { status, statusCode: status, expose: true, type });

  it('answers a body too large, JSON that does not parse and a charset nothing reads with their own status', () => {
    expect(
      toProblemDetails(raised(new Error('request entity too large'), 413, 'entity.too.large'), {
        instance: '/upload',
        requestId: 'r1',
      }),
    ).toMatchObject({
      status: 413,
      code: 'payload_too_large',
      title: 'Payload too large',
      detail: 'request entity too large',
      instance: '/upload',
      requestId: 'r1',
    });
    expect(
      toProblemDetails(
        raised(
          new SyntaxError('Unexpected token } in JSON at position 9'),
          400,
          'entity.parse.failed',
        ),
      ),
    ).toMatchObject({ status: 400, code: 'bad_request', title: 'Bad request' });
    expect(
      toProblemDetails(
        raised(new Error('unsupported charset "UTF-7"'), 415, 'charset.unsupported'),
      ),
    ).toMatchObject({ status: 415, code: 'unsupported_media_type' });
  });

  it('keeps one not marked for the client, or not the client’s fault, an internal error that says nothing', () => {
    const hidden = Object.assign(new Error('secret detail'), { status: 400, expose: false });
    const upstream = Object.assign(new Error('secret detail'), { status: 503, expose: true });
    const claimed = Object.assign(new Error('secret detail'), { status: 413, expose: 'true' });
    for (const error of [hidden, upstream, claimed]) {
      const problem = toProblemDetails(error);
      expect(problem).toMatchObject({ status: 500, code: 'internal_error' });
      expect(problem.detail).not.toContain('secret');
    }
    // A plain object with the shape is not an error anything raised.
    expect(toProblemDetails({ status: 413, expose: true, message: 'x' }).status).toBe(500);
  });
});

describe('unexpected throwables', () => {
  it('never leaks the message in production mode', () => {
    const problem = toProblemDetails(new Error('connection to postgres://user:pw@host failed'));
    expect(problem.status).toBe(500);
    expect(problem.code).toBe('internal_error');
    expect(problem.detail).not.toContain('postgres://');
    expect(problem.detail).toMatch(/request id/i);
  });

  it('exposes the message and stack only when explicitly asked', () => {
    const problem = toProblemDetails(new Error('boom'), { exposeInternals: true });
    expect(problem.detail).toBe('boom');
    expect(problem.meta?.stack).toBeDefined();
  });

  it('survives a thrown string', () => {
    expect(toProblemDetails('just a string')).toMatchObject({ status: 500 });
  });

  it('survives a thrown undefined', () => {
    const problem = toProblemDetails(undefined);
    expect(problem.status).toBe(500);
    expect(problem.type).toBeDefined();
  });

  it('survives a thrown object with no message', () => {
    expect(toProblemDetails({ weird: true })).toMatchObject({ status: 500 });
  });

  it('always produces a document with the required members', () => {
    for (const thrown of [
      new Error('x'),
      'str',
      42,
      null,
      undefined,
      { a: 1 },
      new ConflictError('c'),
    ]) {
      const problem = toProblemDetails(thrown, { requestId: 'r' });
      expect(typeof problem.type).toBe('string');
      expect(typeof problem.title).toBe('string');
      expect(typeof problem.status).toBe('number');
      expect(typeof problem.code).toBe('string');
    }
  });
});

describe('retryAfter', () => {
  it('is carried through for rate limiting', () => {
    expect(toProblemDetails(new RateLimitedError(60)).retryAfter).toBe(60);
  });
});
