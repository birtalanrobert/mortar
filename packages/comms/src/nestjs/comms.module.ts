import { Global, Module, type DynamicModule, type Provider } from '@nestjs/common';
import type { AsyncModuleOptions } from '@birtalanrobert/context';
import { MORTAR_DATA_SOURCE } from '@birtalanrobert/database';
import type { DataSource } from 'typeorm';
import { CommsService, type CommsServiceOptions } from '../comms.service';

export type CommsModuleOptions = CommsServiceOptions;

/**
 * Provides `CommsService` application-wide.
 *
 * Global for the same reason as the others: messaging is not one feature's
 * concern. Reminders send, the inbound webhook receives, and the support screen
 * reads the log.
 */
@Global()
@Module({})
export class CommsModule {
  static forRoot(options: CommsModuleOptions): DynamicModule {
    const provider: Provider = {
      provide: CommsService,
      useFactory: (dataSource: DataSource) => new CommsService(dataSource, options),
      inject: [MORTAR_DATA_SOURCE],
    };
    return { module: CommsModule, providers: [provider], exports: [provider] };
  }

  static forRootAsync(options: AsyncModuleOptions<CommsModuleOptions>): DynamicModule {
    const provider: Provider = {
      provide: CommsService,
      useFactory: async (dataSource: DataSource, ...args: never[]) =>
        new CommsService(dataSource, await options.useFactory(...args)),
      inject: [MORTAR_DATA_SOURCE, ...((options.inject ?? []) as never[])],
    };

    return {
      module: CommsModule,
      imports: (options.imports ?? []) as never[],
      providers: [provider],
      exports: [provider],
    };
  }
}
