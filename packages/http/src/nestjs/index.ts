/**
 * Everything that needs NestJS.
 *
 * Kept behind a subpath so that importing an error class does not import a
 * framework. See the root entry point.
 */
export { MortarExceptionFilter, type ExceptionFilterOptions } from '../exception.filter';

export { ContextMiddleware, type ContextMiddlewareOptions } from '../context.middleware';

export { createValidationPipe, flattenValidationErrors } from '../validation';

export {
  HEALTH_OPTIONS,
  HEALTH_REGISTRY,
  HealthController,
  type HealthControllerOptions,
} from '../health.controller';

export { CONTEXT_OPTIONS, HttpModule, type HttpModuleOptions } from '../nest';

export { PUBLIC_ROUTE_KEY, PublicRoute } from '../public';
