import { Inject } from '@nestjs/common';

/**
 * The injection tokens, in a module of their own.
 *
 * Not in `logger.module.ts`, deliberately. That file imports the adapter and
 * the interceptor so it can provide them, and both of them need these tokens —
 * a cycle. Under CommonJS a cycle does not fail loudly: the token is simply
 * `undefined` at the moment the `@Inject()` decorator runs, so Nest falls back
 * to the constructor's reflected type and reports that it cannot resolve
 * `Function`. Keeping the tokens on a leaf module removes the cycle entirely.
 */
export const MORTAR_LOGGER = Symbol('MORTAR_LOGGER');
export const MORTAR_METRICS = Symbol('MORTAR_METRICS');

/** Injects the application logger. */
export const InjectLogger = () => Inject(MORTAR_LOGGER);

/** Injects the metrics registry. */
export const InjectMetrics = () => Inject(MORTAR_METRICS);
