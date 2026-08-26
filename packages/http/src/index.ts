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

export { MortarExceptionFilter, type ExceptionFilterOptions } from './exception.filter';

export {
  CORRELATION_ID_HEADER,
  ContextMiddleware,
  REQUEST_ID_HEADER,
  negotiateLocale,
  type ContextMiddlewareOptions,
} from './context.middleware';

export { createValidationPipe, flattenValidationErrors } from './validation';

export {
  HealthRegistry,
  createIndicator,
  type HealthIndicator,
  type HealthReport,
  type HealthStatus,
  type IndicatorResult,
} from './health';

export {
  HEALTH_OPTIONS,
  HEALTH_REGISTRY,
  HealthController,
  type HealthControllerOptions,
} from './health.controller';

export { CONTEXT_OPTIONS, HttpModule, type HttpModuleOptions } from './nest';
