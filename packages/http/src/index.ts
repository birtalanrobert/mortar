/**
 * The framework-free half.
 *
 * Nothing here imports `@nestjs/common`, so a Next.js route handler, an edge
 * function or a job runner can raise the same errors and produce the same
 * problem documents as the API without installing a framework to do it. The
 * filter, middleware, pipe, controller and module that wire these into Nest
 * live in `@birtalanrobert/http/nestjs`.
 */
export {
  DEFAULT_PROBLEM_BASE_URI,
  PROBLEM_CONTENT_TYPE,
  problemType,
  type FieldError,
  type ProblemDetails,
} from './problem';

export {
  BadRequestError,
  BusinessRuleError,
  ConflictError,
  CrossTenantAccessError,
  ForbiddenError,
  GoneError,
  InternalError,
  LockedError,
  MortarError,
  NotFoundError,
  PaymentRequiredError,
  PreconditionFailedError,
  RateLimitedError,
  ServiceUnavailableError,
  UnauthenticatedError,
  UpstreamError,
  UpstreamTimeoutError,
  ValidationError,
  VersionConflictError,
  isMortarError,
  type MortarErrorOptions,
} from './errors';

export { toProblemDetails, type SerializeOptions } from './serialize';

export { CORRELATION_ID_HEADER, REQUEST_ID_HEADER, negotiateLocale } from './headers';

export {
  HealthRegistry,
  createIndicator,
  type HealthIndicator,
  type HealthReport,
  type HealthStatus,
  type IndicatorResult,
} from './health';
