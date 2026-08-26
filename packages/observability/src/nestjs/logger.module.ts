import { Global, Module, type DynamicModule, type Provider } from '@nestjs/common';
import type { AsyncModuleOptions } from '@birtalanrobert/context';
import { createLogger, type CreateLoggerOptions } from '../logger';
import { InMemoryMetrics, type Metrics } from '../metrics';
import type { Logger } from '../types';
import { MORTAR_LOGGER, MORTAR_METRICS } from './tokens';
import { LoggingInterceptor } from './logging.interceptor';
import { NestLoggerAdapter } from './nest-logger.adapter';

// Re-exported so existing imports from this module keep working; declared in
// `tokens.ts` to keep this file out of an import cycle with the two helpers
// below.
export { InjectLogger, InjectMetrics, MORTAR_LOGGER, MORTAR_METRICS } from './tokens';

export interface LoggerModuleOptions extends CreateLoggerOptions {
  /**
   * Metrics implementation. Defaults to the in-memory one, which is correct
   * for local work and tests; a deployment supplies its own adapter.
   */
  metrics?: Metrics;
}

/**
 * Classes this module provides in addition to the logger itself.
 *
 * Both are ordinary providers so a consumer can resolve them rather than
 * construct them: `app.useLogger(app.get(NestLoggerAdapter))`, and
 * `{ provide: APP_INTERCEPTOR, useExisting: LoggingInterceptor }`. Constructing
 * them by hand still works, and is what a test with no container does.
 */
const HELPERS: Provider[] = [NestLoggerAdapter, LoggingInterceptor];

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
      ...HELPERS,
    ];

    return { module: LoggerModule, providers, exports: providers };
  }

  /** Configures from other providers — validated config, most often. */
  static forRootAsync(options: AsyncModuleOptions<LoggerModuleOptions>): DynamicModule {
    const loggerProvider: Provider = {
      provide: MORTAR_LOGGER,
      useFactory: async (...args: never[]) => {
        const { metrics: _metrics, ...loggerOptions } = await options.useFactory(...args);
        return createLogger(loggerOptions);
      },
      inject: (options.inject ?? []) as never[],
    };

    const metricsProvider: Provider = {
      provide: MORTAR_METRICS,
      useFactory: async (...args: never[]) => {
        const { metrics } = await options.useFactory(...args);
        return metrics ?? new InMemoryMetrics();
      },
      inject: (options.inject ?? []) as never[],
    };

    const providers: Provider[] = [loggerProvider, metricsProvider, ...HELPERS];
    return {
      module: LoggerModule,
      imports: (options.imports ?? []) as never[],
      providers,
      exports: providers,
    };
  }

  /** Provides an already-constructed logger, for tests and unusual wiring. */
  static forRootWithLogger(logger: Logger, metrics?: Metrics): DynamicModule {
    const providers: Provider[] = [
      { provide: MORTAR_LOGGER, useValue: logger },
      { provide: MORTAR_METRICS, useValue: metrics ?? new InMemoryMetrics() },
      ...HELPERS,
    ];
    return { module: LoggerModule, providers, exports: providers };
  }
}
