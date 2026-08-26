import { Global, Module, type DynamicModule, type Provider } from '@nestjs/common';
import type { AsyncModuleOptions } from '@birtalanrobert/context';
import { MORTAR_DATA_SOURCE } from '@birtalanrobert/database';
import type { DataSource } from 'typeorm';
import { LinkService, type LinkServiceOptions } from '../links/link.service';

/**
 * An alias today, and a name with room to grow.
 *
 * The module will configure more than links — state machines, due-date
 * calendars — and naming the options type now means adding those later is not a
 * breaking rename for every consumer.
 */
export type WorkflowModuleOptions = LinkServiceOptions;

/**
 * Provides `LinkService` application-wide.
 *
 * Global for the same reason the logger is: practically every feature that
 * involves someone outside the system touches a link, and threading a module
 * import through every feature module to reach it is friction with no benefit.
 */
@Global()
@Module({})
export class WorkflowModule {
  static forRoot(options: WorkflowModuleOptions): DynamicModule {
    const provider: Provider = {
      provide: LinkService,
      useFactory: (dataSource: DataSource) => new LinkService(dataSource, options),
      inject: [MORTAR_DATA_SOURCE],
    };
    return { module: WorkflowModule, providers: [provider], exports: [provider] };
  }

  /**
   * Configures from other providers — the validated config, most often.
   *
   * The signing secret must come from the environment, and reading it at import
   * time would mean reading it before anything validated it.
   */
  static forRootAsync(options: AsyncModuleOptions<WorkflowModuleOptions>): DynamicModule {
    const provider: Provider = {
      provide: LinkService,
      useFactory: async (dataSource: DataSource, ...args: never[]) =>
        new LinkService(dataSource, await options.useFactory(...args)),
      inject: [MORTAR_DATA_SOURCE, ...((options.inject ?? []) as never[])],
    };

    return {
      module: WorkflowModule,
      imports: (options.imports ?? []) as never[],
      providers: [provider],
      exports: [provider],
    };
  }
}
