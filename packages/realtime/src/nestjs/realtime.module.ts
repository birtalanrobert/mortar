import { Global, Module, type DynamicModule, type Provider } from '@nestjs/common';
import { RealtimePublisher } from '../server/publisher';
import type { BacklogPort } from '../server/backlog';

export const MORTAR_REALTIME_BACKLOG = Symbol('mortar.realtime.backlog');

export interface RealtimeModuleOptions {
  readonly backlog: BacklogPort;
  /** How an event reaches the other gateway processes. Absent for one. */
  readonly broadcast?: (event: import('../wire').RealtimeEvent) => Promise<void> | void;
}

export interface RealtimeModuleAsyncOptions {
  readonly inject?: readonly unknown[];
  readonly useFactory: (...args: never[]) => RealtimeModuleOptions | Promise<RealtimeModuleOptions>;
}

/**
 * `RealtimePublisher`, wired.
 *
 * **The ports are constructed by the application, not by this module.** Which
 * Redis, which key prefix, how deep the backlog goes and whether there is more
 * than one gateway process are deployment decisions — a module that reached for
 * them itself would be reading configuration nothing had validated, which is
 * the same posture `files` and `comms` take with storage and transports.
 *
 * The socket server is deliberately **not** here. It needs the HTTP server the
 * application creates in `main.ts`, and a module that tried to own that would
 * either guess at the bootstrap order or hold a reference to something that
 * does not exist yet.
 */
@Global()
@Module({})
export class RealtimeModule {
  static forRoot(options: RealtimeModuleOptions): DynamicModule {
    return this.build([
      { provide: MORTAR_REALTIME_BACKLOG, useValue: options.backlog },
      {
        provide: RealtimePublisher,
        useFactory: () =>
          new RealtimePublisher({ backlog: options.backlog, broadcast: options.broadcast }),
      },
    ]);
  }

  static forRootAsync(options: RealtimeModuleAsyncOptions): DynamicModule {
    const resolved: Provider = {
      provide: MORTAR_REALTIME_BACKLOG,
      inject: [...(options.inject ?? [])] as never[],
      useFactory: async (...args: never[]) => (await options.useFactory(...args)).backlog,
    };

    return this.build([
      resolved,
      {
        provide: RealtimePublisher,
        inject: [...(options.inject ?? [])] as never[],
        useFactory: async (...args: never[]) => {
          const settings = await options.useFactory(...args);

          return new RealtimePublisher({
            backlog: settings.backlog,
            broadcast: settings.broadcast,
          });
        },
      },
    ]);
  }

  private static build(providers: Provider[]): DynamicModule {
    return {
      module: RealtimeModule,
      providers,
      exports: [RealtimePublisher, MORTAR_REALTIME_BACKLOG],
    };
  }
}
