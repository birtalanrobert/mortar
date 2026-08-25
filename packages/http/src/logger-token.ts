/**
 * Re-exports the logger token so that `@mortar/http` can accept a logger
 * without importing `@mortar/observability`'s NestJS entry point — which would
 * drag `@nestjs/common` into a package that some consumers use purely for its
 * error classes.
 */
export { MORTAR_LOGGER } from '@mortar/observability/nestjs';
export type { Logger } from '@mortar/observability';
