/**
 * Re-exports the logger token so that `@birtalanrobert/http` can accept a logger
 * without importing `@birtalanrobert/observability`'s NestJS entry point — which would
 * drag `@nestjs/common` into a package that some consumers use purely for its
 * error classes.
 */
export { MORTAR_LOGGER } from '@birtalanrobert/observability/nestjs';
export type { Logger } from '@birtalanrobert/observability';
