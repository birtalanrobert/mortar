import {
  Global,
  Inject,
  Module,
  type DynamicModule,
  type MiddlewareConsumer,
  type NestModule,
  type Provider,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { AsyncModuleOptions } from '@birtalanrobert/context';
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
 * One import gives an application the conventions every consumer
 * share, and nothing here is domain-specific.
 */
export const CONTEXT_OPTIONS = Symbol('MORTAR_CONTEXT_OPTIONS');

@Global()
@Module({})
export class HttpModule implements NestModule {
  constructor(@Inject(CONTEXT_OPTIONS) private readonly contextOptions: ContextMiddlewareOptions) {}

  static forRoot(options: HttpModuleOptions = {}): DynamicModule {
    const registry = new HealthRegistry();
    for (const indicator of options.health?.indicators ?? []) {
      registry.register(indicator);
    }

    const providers: Provider[] = [
      { provide: CONTEXT_OPTIONS, useValue: options.context ?? {} },
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
      exports: [HEALTH_REGISTRY, CONTEXT_OPTIONS],
    };
  }

  /**
   * Configures from other providers — validated config, most often.
   *
   * Note that health indicators cannot be supplied here: they are usually
   * built from services this module has no way to reach, so register them on
   * the injected `HealthRegistry` from whichever module owns the dependency.
   */
  static forRootAsync(options: AsyncModuleOptions<HttpModuleOptions>): DynamicModule {
    const registry = new HealthRegistry();

    const providers: Provider[] = [
      {
        provide: CONTEXT_OPTIONS,
        useFactory: async (...args: never[]) => (await options.useFactory(...args)).context ?? {},
        inject: (options.inject ?? []) as never[],
      },
      { provide: HEALTH_REGISTRY, useValue: registry },
      {
        provide: HEALTH_OPTIONS,
        useFactory: async (...args: never[]) => {
          const resolved = await options.useFactory(...args);
          for (const indicator of resolved.health?.indicators ?? []) registry.register(indicator);
          return {
            detailed: resolved.health?.detailed ?? false,
            timeoutMs: resolved.health?.timeoutMs ?? 5000,
          } satisfies HealthControllerOptions;
        },
        inject: (options.inject ?? []) as never[],
      },
      {
        provide: APP_FILTER,
        useFactory: async (logger: Logger | undefined, ...args: never[]) => {
          const resolved = await options.useFactory(...args);
          return new MortarExceptionFilter(logger, resolved.errors ?? {});
        },
        inject: [{ token: MORTAR_LOGGER, optional: true }, ...((options.inject ?? []) as never[])],
      },
    ];

    return {
      module: HttpModule,
      imports: (options.imports ?? []) as never[],
      controllers: [HealthController],
      providers,
      exports: [HEALTH_REGISTRY, CONTEXT_OPTIONS],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    // Applied to every route, including the health endpoints, so that even a
    // failing readiness check carries a request id.
    const middleware = new ContextMiddleware(this.contextOptions);
    consumer
      .apply((request: never, response: never, next: () => void) =>
        middleware.use(request, response, next),
      )
      .forRoutes('*');
  }
}
