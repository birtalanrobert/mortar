import {
  Global,
  Module,
  type DynamicModule,
  type MiddlewareConsumer,
  type NestModule,
  type Provider,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ContextMiddleware, type ContextMiddlewareOptions } from './context.middleware';
import { MortarExceptionFilter, type ExceptionFilterOptions } from './exception.filter';
import { HealthRegistry, type HealthIndicator } from './health';
import {
  HEALTH_OPTIONS,
  HEALTH_REGISTRY,
  HealthController,
  type HealthControllerOptions,
} from './health.controller';
import { MORTAR_LOGGER, type Logger } from './logger-token';

export interface HttpModuleOptions {
  context?: ContextMiddlewareOptions;
  errors?: ExceptionFilterOptions;
  health?: HealthControllerOptions & {
    /** Indicators available at construction. More can be registered later. */
    indicators?: HealthIndicator[];
    /** Mount the health controller. Defaults to true. */
    enabled?: boolean;
  };
}

/**
 * Wires the request context, the exception filter and the health endpoints.
 *
 * One import gives an application the conventions all seventeen projects
 * share, and nothing here is domain-specific.
 */
@Global()
@Module({})
export class HttpModule implements NestModule {
  private static contextOptions: ContextMiddlewareOptions = {};

  static forRoot(options: HttpModuleOptions = {}): DynamicModule {
    HttpModule.contextOptions = options.context ?? {};

    const registry = new HealthRegistry();
    for (const indicator of options.health?.indicators ?? []) {
      registry.register(indicator);
    }

    const providers: Provider[] = [
      { provide: HEALTH_REGISTRY, useValue: registry },
      {
        provide: HEALTH_OPTIONS,
        useValue: {
          detailed: options.health?.detailed ?? false,
          timeoutMs: options.health?.timeoutMs ?? 5000,
        } satisfies HealthControllerOptions,
      },
      {
        provide: APP_FILTER,
        useFactory: (logger?: Logger) => new MortarExceptionFilter(logger, options.errors ?? {}),
        inject: [{ token: MORTAR_LOGGER, optional: true }],
      },
    ];

    return {
      module: HttpModule,
      controllers: options.health?.enabled === false ? [] : [HealthController],
      providers,
      exports: [HEALTH_REGISTRY],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    // Applied to every route, including the health endpoints, so that even a
    // failing readiness check carries a request id.
    consumer
      .apply((request: never, response: never, next: () => void) =>
        new ContextMiddleware(HttpModule.contextOptions).use(request, response, next),
      )
      .forRoutes('*');
  }
}
