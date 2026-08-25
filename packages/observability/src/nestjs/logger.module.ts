import { Global, Inject, Module, type DynamicModule, type Provider } from '@nestjs/common';
import { createLogger, type CreateLoggerOptions } from '../logger';
import { InMemoryMetrics, type Metrics } from '../metrics';
import type { Logger } from '../types';

export const MORTAR_LOGGER = Symbol('MORTAR_LOGGER');
export const MORTAR_METRICS = Symbol('MORTAR_METRICS');

/** Injects the application logger. */
export const InjectLogger = () => Inject(MORTAR_LOGGER);

/** Injects the metrics registry. */
export const InjectMetrics = () => Inject(MORTAR_METRICS);

export interface LoggerModuleOptions extends CreateLoggerOptions {
  /**
   * Metrics implementation. Defaults to the in-memory one, which is correct
   * for local work and tests; a deployment supplies its own adapter.
   */
  metrics?: Metrics;
}

/**
 * Provides the logger and the metrics registry application-wide.
 *
 * Global because practically every provider wants a logger, and threading a
 * module import through fifty feature modules to obtain one is friction with
 * no benefit.
 */
@Global()
@Module({})
export class LoggerModule {
  static forRoot(options: LoggerModuleOptions): DynamicModule {
    const { metrics, ...loggerOptions } = options;

    const providers: Provider[] = [
      { provide: MORTAR_LOGGER, useValue: createLogger(loggerOptions) },
      { provide: MORTAR_METRICS, useValue: metrics ?? new InMemoryMetrics() },
    ];

    return { module: LoggerModule, providers, exports: providers };
  }

  /** Provides an already-constructed logger, for tests and unusual wiring. */
  static forRootWithLogger(logger: Logger, metrics?: Metrics): DynamicModule {
    const providers: Provider[] = [
      { provide: MORTAR_LOGGER, useValue: logger },
      { provide: MORTAR_METRICS, useValue: metrics ?? new InMemoryMetrics() },
    ];
    return { module: LoggerModule, providers, exports: providers };
  }
}
