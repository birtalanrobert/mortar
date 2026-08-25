import type { FieldError, ProblemDetails } from './problem';
import { problemType } from './problem';

export interface MortarErrorOptions {
  /** Explanation specific to this occurrence. */
  detail?: string;
  /** Field-level failures. */
  errors?: FieldError[];
  /** Additional context. Must never contain internals or secrets. */
  meta?: Record<string, unknown>;
  /** Seconds to wait before retrying. */
  retryAfter?: number;
  /** The underlying failure, for logging. Never serialized to the client. */
  cause?: unknown;
}

/**
 * The base error for everything this catalogue throws deliberately.
 *
 * Framework-free on purpose: domain code, workers, CLI tools and tests all
 * throw these, and only the HTTP layer knows how to turn one into a response.
 * A domain module that had to import `@nestjs/common` to say "not found" would
 * be a domain module coupled to a web framework for no reason.
 */
export class MortarError extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail?: string;
  readonly errors?: FieldError[];
  readonly meta?: Record<string, unknown>;
  readonly retryAfter?: number;

  constructor(status: number, code: string, title: string, options: MortarErrorOptions = {}) {
    super(options.detail ?? title, options.cause ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.title = title;
    this.detail = options.detail;
    this.errors = options.errors;
    this.meta = options.meta;
    this.retryAfter = options.retryAfter;
  }

  /** Whether this is a client's fault (4xx) rather than ours. */
  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500;
  }

  toProblemDetails(
    options: { instance?: string; requestId?: string; baseUri?: string } = {},
  ): ProblemDetails {
    const problem: ProblemDetails = {
      type: problemType(this.code, options.baseUri),
      title: this.title,
      status: this.status,
      code: this.code,
    };
    if (this.detail) problem.detail = this.detail;
    if (options.instance) problem.instance = options.instance;
    if (options.requestId) problem.requestId = options.requestId;
    if (this.errors?.length) problem.errors = this.errors;
    if (this.retryAfter !== undefined) problem.retryAfter = this.retryAfter;
    if (this.meta) problem.meta = this.meta;
    return problem;
  }
}

/** 400 — the request itself is malformed. */
export class BadRequestError extends MortarError {
  constructor(detail?: string, options: MortarErrorOptions = {}) {
    super(400, 'bad_request', 'Bad request', { ...options, detail });
  }
}

/** 401 — no credentials, or credentials we could not verify. */
export class UnauthenticatedError extends MortarError {
  constructor(detail = 'Authentication is required.', options: MortarErrorOptions = {}) {
    super(401, 'unauthenticated', 'Not authenticated', { ...options, detail });
  }
}

/** 403 — authenticated, but not allowed to do this. */
export class ForbiddenError extends MortarError {
  constructor(
    detail = 'You do not have permission to perform this action.',
    options: MortarErrorOptions = {},
  ) {
    super(403, 'forbidden', 'Forbidden', { ...options, detail });
  }
}

/**
 * 403 — an attempt to reach another tenant's data.
 *
 * Distinct from a plain Forbidden so that it can be alerted on separately:
 * in a multi-tenant system this is either a serious bug or an attack, and
 * either way somebody should find out today rather than at the next audit.
 */
export class CrossTenantAccessError extends MortarError {
  constructor(
    detail = 'This resource belongs to a different tenant.',
    options: MortarErrorOptions = {},
  ) {
    super(403, 'cross_tenant_access', 'Cross-tenant access denied', { ...options, detail });
  }
}

/** 404 — no such thing, or nothing this actor is allowed to know about. */
export class NotFoundError extends MortarError {
  constructor(resource = 'Resource', identifier?: string, options: MortarErrorOptions = {}) {
    super(404, 'not_found', `${resource} not found`, {
      ...options,
      detail:
        options.detail ??
        (identifier ? `${resource} '${identifier}' was not found.` : `${resource} was not found.`),
    });
  }
}

/** 409 — the request conflicts with the current state. */
export class ConflictError extends MortarError {
  constructor(detail: string, options: MortarErrorOptions = {}) {
    super(409, 'conflict', 'Conflict', { ...options, detail });
  }
}

/**
 * 409 — the record changed since it was read.
 *
 * Optimistic concurrency. Several projects here have two people editing the
 * same week's rota or the same order, and last-write-wins silently discarding
 * someone's work is worse than an error they can act on.
 */
export class VersionConflictError extends MortarError {
  constructor(
    detail = 'This record was modified by someone else. Reload and try again.',
    options: MortarErrorOptions = {},
  ) {
    super(409, 'version_conflict', 'Version conflict', { ...options, detail });
  }
}

/**
 * 410 — the resource existed and is deliberately gone.
 *
 * The correct answer for an expired signed link, which every link-based
 * surface in this catalogue produces. A 404 would suggest the link was never
 * valid and send the recipient to support; a 410 lets the page say "this link
 * has expired, request a new one".
 */
export class GoneError extends MortarError {
  constructor(detail = 'This resource is no longer available.', options: MortarErrorOptions = {}) {
    super(410, 'gone', 'No longer available', { ...options, detail });
  }
}

/** 412 — a precondition (If-Match, expected state) was not met. */
export class PreconditionFailedError extends MortarError {
  constructor(detail: string, options: MortarErrorOptions = {}) {
    super(412, 'precondition_failed', 'Precondition failed', { ...options, detail });
  }
}

/** 422 — well-formed request, but the content fails validation or a business rule. */
export class ValidationError extends MortarError {
  constructor(
    errors: FieldError[],
    detail = 'The submitted data is not valid.',
    options: MortarErrorOptions = {},
  ) {
    super(422, 'validation_failed', 'Validation failed', { ...options, detail, errors });
  }
}

/**
 * 422 — a business rule refuses the request.
 *
 * Separate from field validation because the two need different treatment in
 * a UI: a field error highlights an input, a rule violation needs an
 * explanation. `code` is caller-supplied so the specific rule is identifiable.
 */
export class BusinessRuleError extends MortarError {
  constructor(code: string, title: string, detail: string, options: MortarErrorOptions = {}) {
    super(422, code, title, { ...options, detail });
  }
}

/** 423 — the resource is held by someone else right now. */
export class LockedError extends MortarError {
  constructor(detail = 'This resource is currently locked.', options: MortarErrorOptions = {}) {
    super(423, 'locked', 'Locked', { ...options, detail });
  }
}

/** 429 — too many requests. Always carries `retryAfter`. */
export class RateLimitedError extends MortarError {
  constructor(
    retryAfter: number,
    detail = 'Too many requests. Please slow down.',
    options: MortarErrorOptions = {},
  ) {
    super(429, 'rate_limited', 'Too many requests', { ...options, detail, retryAfter });
  }
}

/**
 * 402 — the tenant's plan does not include this.
 *
 * Every project in the catalogue gates features by plan, and a 403 for a
 * billing reason sends the user to support rather than to the upgrade page.
 */
export class PaymentRequiredError extends MortarError {
  constructor(
    detail = 'Your plan does not include this feature.',
    options: MortarErrorOptions = {},
  ) {
    super(402, 'payment_required', 'Plan upgrade required', { ...options, detail });
  }
}

/** 500 — our fault. Detail is never shown to the client in production. */
export class InternalError extends MortarError {
  constructor(detail = 'An unexpected error occurred.', options: MortarErrorOptions = {}) {
    super(500, 'internal_error', 'Internal error', { ...options, detail });
  }
}

/** 502 — a dependency we call returned something unusable. */
export class UpstreamError extends MortarError {
  constructor(service: string, options: MortarErrorOptions = {}) {
    super(502, 'upstream_error', 'Upstream service error', {
      ...options,
      detail: options.detail ?? `The ${service} service returned an error.`,
      meta: { service, ...options.meta },
    });
  }
}

/** 503 — temporarily unable to serve. Carries `retryAfter` where known. */
export class ServiceUnavailableError extends MortarError {
  constructor(
    detail = 'The service is temporarily unavailable.',
    options: MortarErrorOptions = {},
  ) {
    super(503, 'service_unavailable', 'Service unavailable', { ...options, detail });
  }
}

/** 504 — a dependency did not answer in time. */
export class UpstreamTimeoutError extends MortarError {
  constructor(service: string, timeoutMs: number, options: MortarErrorOptions = {}) {
    super(504, 'upstream_timeout', 'Upstream timeout', {
      ...options,
      detail: options.detail ?? `The ${service} service did not respond within ${timeoutMs}ms.`,
      meta: { service, timeoutMs, ...options.meta },
    });
  }
}

/** Type guard for values caught in a filter or a job handler. */
export function isMortarError(value: unknown): value is MortarError {
  return value instanceof MortarError;
}
