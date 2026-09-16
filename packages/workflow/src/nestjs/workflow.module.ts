import { Global, Module, type DynamicModule, type Provider } from '@nestjs/common';
import type { AsyncModuleOptions } from '@birtalanrobert/context';
import { MORTAR_DATA_SOURCE } from '@birtalanrobert/database';
import type { DataSource } from 'typeorm';
import { LinkService, type LinkServiceOptions } from '../links/link.service';
import { PublicLinkService } from '../links/public-link.service';

/**
 * An alias today, and a name with room to grow.
 *
 * The module will configure more than links — state machines, due-date
 * calendars — and naming the options type now means adding those later is not a
 * breaking rename for every consumer.
 */
export type WorkflowModuleOptions = LinkServiceOptions;

/**
 * Provides both link services application-wide.
 *
 * Global for the same reason the logger is: practically every feature that
 * involves someone outside the system touches a link, and threading a module
 * import through every feature module to reach it is friction with no benefit.
 *
 * **Two services, because a link has two shapes and products need both.**
 * `LinkService` signs a stateless token with an expiry in it — right for an
 * invitation, where the link is sent once and the claim travels inside it.
 * `PublicLinkService` keeps a row, so the same address can be *re-derived* later
 * and revoked by updating it — right for a page somebody pastes onto a
 * classifieds site and comes back for a week later.
 *
 * `PublicLinkService` was provided here only after three products had
 * constructed it by hand, which was the tell: the package already shipped its
 * entity and migration in `workflowEntities`, so it was telling consumers to
 * use a service they could not inject.
 */
@Global()
@Module({})
export class WorkflowModule {
  static forRoot(options: WorkflowModuleOptions): DynamicModule {
    const providers = WorkflowModule.providersFor(
      (dataSource: DataSource) => Promise.resolve([dataSource, options] as const),
      [MORTAR_DATA_SOURCE],
    );

    return { module: WorkflowModule, providers, exports: providers };
  }

  /**
   * Configures from other providers — the validated config, most often.
   *
   * The signing secret must come from the environment, and reading it at import
   * time would mean reading it before anything validated it.
   */
  static forRootAsync(options: AsyncModuleOptions<WorkflowModuleOptions>): DynamicModule {
    const providers = WorkflowModule.providersFor(
      async (dataSource: DataSource, ...args: never[]) =>
        [dataSource, await options.useFactory(...args)] as const,
      [MORTAR_DATA_SOURCE, ...((options.inject ?? []) as never[])],
    );

    return {
      module: WorkflowModule,
      imports: (options.imports ?? []) as never[],
      providers,
      exports: providers,
    };
  }

  /**
   * One resolution of the options, two services built from it.
   *
   * Written this way so the async factory runs once per service with the same
   * inputs rather than the options being resolved twice — which for a factory
   * that reads configuration is harmless and for one that does anything else is
   * a surprise waiting to be found.
   */
  private static providersFor(
    resolve: (
      dataSource: DataSource,
      ...args: never[]
    ) => Promise<readonly [DataSource, WorkflowModuleOptions]>,
    inject: unknown[],
  ): Provider[] {
    return [
      {
        provide: LinkService,
        useFactory: async (dataSource: DataSource, ...args: never[]) => {
          const [source, options] = await resolve(dataSource, ...args);
          return new LinkService(source, options);
        },
        inject: inject as never[],
      },
      {
        provide: PublicLinkService,
        useFactory: async (dataSource: DataSource, ...args: never[]) => {
          const [source, options] = await resolve(dataSource, ...args);
          return new PublicLinkService(source, options);
        },
        inject: inject as never[],
      },
    ];
  }
}
