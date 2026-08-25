import { describe, expect, it } from 'vitest';
import {
  BusinessRuleError,
  ConflictError,
  CrossTenantAccessError,
  ForbiddenError,
  GoneError,
  InternalError,
  MortarError,
  NotFoundError,
  PaymentRequiredError,
  RateLimitedError,
  UpstreamError,
  UpstreamTimeoutError,
  ValidationError,
  VersionConflictError,
  isMortarError,
} from './errors';

describe('MortarError', () => {
  it('carries status, code and title', () => {
    const error = new MortarError(418, 'teapot', 'I am a teapot');
    expect(error.status).toBe(418);
    expect(error.code).toBe('teapot');
    expect(error.title).toBe('I am a teapot');
  });

  it('names itself after the concrete subclass, which is what appears in logs', () => {
    expect(new NotFoundError().name).toBe('NotFoundError');
    expect(new ConflictError('x').name).toBe('ConflictError');
  });

  it('uses detail as the Error message when supplied', () => {
    expect(new ConflictError('Seat already sold').message).toBe('Seat already sold');
  });

  it('preserves the cause for logging without serializing it', () => {
    const cause = new Error('underlying');
    const error = new InternalError('failed', { cause });
    expect(error.cause).toBe(cause);
    expect(JSON.stringify(error.toProblemDetails())).not.toContain('underlying');
  });

  it('distinguishes client errors from ours', () => {
    expect(new NotFoundError().isClientError).toBe(true);
    expect(new InternalError().isClientError).toBe(false);
  });

  it('is recognised by the type guard', () => {
    expect(isMortarError(new NotFoundError())).toBe(true);
    expect(isMortarError(new Error('plain'))).toBe(false);
    expect(isMortarError(undefined)).toBe(false);
  });
});

describe('toProblemDetails', () => {
  it('produces a valid problem document', () => {
    const problem = new NotFoundError('Booking', 'abc').toProblemDetails({
      instance: '/bookings/abc',
      requestId: 'req-1',
    });
    expect(problem).toEqual({
      type: 'https://problems.mortar.dev/not_found',
      title: 'Booking not found',
      status: 404,
      code: 'not_found',
      detail: "Booking 'abc' was not found.",
      instance: '/bookings/abc',
      requestId: 'req-1',
    });
  });

  it('honours a deployment-specific base uri', () => {
    const problem = new NotFoundError().toProblemDetails({
      baseUri: 'https://errors.example.com/',
    });
    expect(problem.type).toBe('https://errors.example.com/not_found');
  });

  it('omits absent fields rather than emitting nulls', () => {
    const problem = new ForbiddenError().toProblemDetails();
    expect(Object.keys(problem).sort()).toEqual(['code', 'detail', 'status', 'title', 'type']);
  });

  it('includes retryAfter for rate limiting', () => {
    expect(new RateLimitedError(30).toProblemDetails().retryAfter).toBe(30);
  });

  it('includes field errors for validation failures', () => {
    const problem = new ValidationError([
      { field: 'email', message: 'must be an email', code: 'is_email' },
    ]).toProblemDetails();
    expect(problem.status).toBe(422);
    expect(problem.errors).toHaveLength(1);
    expect(problem.errors?.[0]?.field).toBe('email');
  });
});

describe('specific errors', () => {
  it('cross-tenant access has its own code so it can be alerted on', () => {
    const error = new CrossTenantAccessError();
    expect(error.status).toBe(403);
    expect(error.code).toBe('cross_tenant_access');
  });

  it('gone is used for expired links, distinct from never-existed', () => {
    expect(new GoneError().status).toBe(410);
  });

  it('version conflict is a 409 with an actionable message', () => {
    expect(new VersionConflictError().status).toBe(409);
    expect(new VersionConflictError().detail).toMatch(/Reload/);
  });

  it('payment required points at billing, not at support', () => {
    const error = new PaymentRequiredError();
    expect(error.status).toBe(402);
    expect(error.code).toBe('payment_required');
  });

  it('business rule errors carry a caller-supplied code', () => {
    const error = new BusinessRuleError('seat_already_sold', 'Seat unavailable', 'Taken.');
    expect(error.status).toBe(422);
    expect(error.code).toBe('seat_already_sold');
  });

  it('upstream errors name the service in meta', () => {
    expect(new UpstreamError('stripe').toProblemDetails().meta).toEqual({ service: 'stripe' });
    expect(new UpstreamTimeoutError('stripe', 5000).toProblemDetails().meta).toEqual({
      service: 'stripe',
      timeoutMs: 5000,
    });
  });
});
