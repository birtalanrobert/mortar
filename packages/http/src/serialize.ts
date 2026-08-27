import type { FieldError, ProblemDetails } from './problem';
import { problemType } from './problem';
import { MortarError } from './errors';

export interface SerializeOptions {
  /** Request path, for `instance`. */
  instance?: string;
  /** Correlates the response with the logs. */
  requestId?: string;
  /** Base URI for problem `type` links. */
  baseUri?: string;
  /**
   * Include the real message and stack for 5xx responses.
   *
   * Never true in production: an unexpected error's message routinely contains
   * a SQL fragment, a file path or a connection string, and the client has no
   * use for any of it. In production a 5xx returns a generic message plus the
   * requestId, and the detail lives in the logs where it belongs.
   */
  exposeInternals?: boolean;
}

/**
 * Converts anything thrown into Problem Details.
 *
 * Deliberately total: whatever arrives — a MortarError, a Nest HttpException,
 * a TypeError, a string, `undefined` — comes out as a valid problem document.
 * An error handler that can itself fail is not an error handler.
 */
export function toProblemDetails(thrown: unknown, options: SerializeOptions = {}): ProblemDetails {
  const { instance, requestId, baseUri, exposeInternals = false } = options;

  if (thrown instanceof MortarError) {
    return thrown.toProblemDetails({ instance, requestId, baseUri });
  }

  if (isHttpException(thrown)) {
    return fromHttpException(thrown, options);
  }

  // Anything else is unexpected, and therefore ours.
  const problem: ProblemDetails = {
    type: problemType('internal_error', baseUri),
    title: 'Internal error',
    status: 500,
    code: 'internal_error',
    detail: exposeInternals
      ? thrown instanceof Error
        ? thrown.message
        : String(thrown)
      : 'An unexpected error occurred. Quote the request id when reporting this.',
  };
  if (instance) problem.instance = instance;
  if (requestId) problem.requestId = requestId;
  if (exposeInternals && thrown instanceof Error && thrown.stack) {
    problem.meta = { stack: thrown.stack.split('\n') };
  }
  return problem;
}

/**
 * A Nest `HttpException`, recognised by shape rather than by identity.
 *
 * Two reasons, and the second is the one that matters. The first is that
 * `instanceof` here would mean importing `@nestjs/common` into the framework-
 * free entry point, for a type guard.
 *
 * The second is that `instanceof` is *less* reliable for this particular job.
 * A monorepo or a mismatched peer range readily ends up with two copies of
 * `@nestjs/common`, and an exception thrown by one is not `instanceof` the
 * class from the other — so the framework's own validation errors would
 * silently fall through to the generic 500 branch. This function is documented
 * as total; recognising the contract rather than the constructor is what makes
 * that true.
 */
interface HttpExceptionLike {
  getStatus(): number;
  getResponse(): string | object;
}

function isHttpException(value: unknown): value is HttpExceptionLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as HttpExceptionLike).getStatus === 'function' &&
    typeof (value as HttpExceptionLike).getResponse === 'function'
  );
}

/**
 * Maps a Nest HttpException, including the shape its built-in ValidationPipe
 * produces, into the same problem document as everything else.
 *
 * Without this, a validation failure from the framework would look completely
 * different to a validation failure from application code, and every client
 * would need two error handlers.
 */
function fromHttpException(
  exception: HttpExceptionLike,
  options: SerializeOptions,
): ProblemDetails {
  const status = exception.getStatus();
  const response = exception.getResponse();
  const code = statusToCode(status);

  const problem: ProblemDetails = {
    type: problemType(code, options.baseUri),
    title: titleForStatus(status),
    status,
    code,
  };
  if (options.instance) problem.instance = options.instance;
  if (options.requestId) problem.requestId = options.requestId;

  if (typeof response === 'string') {
    problem.detail = response;
    return problem;
  }

  if (response && typeof response === 'object') {
    const body = response as { message?: unknown; error?: unknown };

    // Nest's ValidationPipe puts an array of strings in `message`.
    if (Array.isArray(body.message)) {
      problem.code = 'validation_failed';
      problem.type = problemType('validation_failed', options.baseUri);
      problem.title = 'Validation failed';
      problem.detail = 'The submitted data is not valid.';
      problem.errors = body.message.map(parseValidationMessage);
      return problem;
    }

    if (typeof body.message === 'string') problem.detail = body.message;
    else if (typeof body.error === 'string') problem.detail = body.error;
  }

  return problem;
}

/**
 * Recovers a field name from class-validator's flattened message strings,
 * which arrive as e.g. `email must be an email`.
 *
 * Best-effort by nature. The structured pipe in `validation.ts` produces
 * proper field errors; this path exists for the framework's own default pipe,
 * which has already discarded the structure by the time we see it.
 */
function parseValidationMessage(message: unknown): FieldError {
  const text = String(message);
  const field = /^([A-Za-z0-9_.[\]]+)\s/.exec(text)?.[1];
  return field ? { field, message: text } : { field: '_', message: text };
}

function statusToCode(status: number): string {
  const codes: Record<number, string> = {
    400: 'bad_request',
    401: 'unauthenticated',
    402: 'payment_required',
    403: 'forbidden',
    404: 'not_found',
    405: 'method_not_allowed',
    406: 'not_acceptable',
    408: 'request_timeout',
    409: 'conflict',
    410: 'gone',
    412: 'precondition_failed',
    413: 'payload_too_large',
    415: 'unsupported_media_type',
    422: 'validation_failed',
    423: 'locked',
    429: 'rate_limited',
    500: 'internal_error',
    501: 'not_implemented',
    502: 'upstream_error',
    503: 'service_unavailable',
    504: 'upstream_timeout',
  };
  return codes[status] ?? (status >= 500 ? 'internal_error' : 'error');
}

function titleForStatus(status: number): string {
  const titles: Record<number, string> = {
    400: 'Bad request',
    401: 'Not authenticated',
    402: 'Plan upgrade required',
    403: 'Forbidden',
    404: 'Not found',
    405: 'Method not allowed',
    406: 'Not acceptable',
    408: 'Request timeout',
    409: 'Conflict',
    410: 'No longer available',
    412: 'Precondition failed',
    413: 'Payload too large',
    415: 'Unsupported media type',
    422: 'Validation failed',
    423: 'Locked',
    429: 'Too many requests',
    500: 'Internal error',
    501: 'Not implemented',
    502: 'Upstream service error',
    503: 'Service unavailable',
    504: 'Upstream timeout',
  };
  return titles[status] ?? (status >= 500 ? 'Internal error' : 'Request failed');
}
