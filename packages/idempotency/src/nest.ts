import { Global, Module, type DynamicModule, type Provider } from '@nestjs/common';
import type { AsyncModuleOptions } from '@birtalanrobert/context';
import { MORTAR_DATA_SOURCE } from '@birtalanrobert/database';
import type { DataSource } from 'typeorm';
import { IdempotencyInterceptor } from './interceptor';
import { IdempotencyService, type IdempotencyOptions } from './service';

@Global()
@Module({})
export class IdempotencyModule {
  static forRoot(options: IdempotencyOptions = {}): DynamicModule {
    const serviceProvider: Provider = {
      provide: IdempotencyService,
      useFactory: (dataSource: DataSource) => new IdempotencyService(dataSource, options),
      inject: [MORTAR_DATA_SOURCE],
    };
    return {
      module: IdempotencyModule,
      providers: [serviceProvider, IdempotencyInterceptor],
      exports: [serviceProvider, IdempotencyInterceptor],
    };
  }

  /** Configures from other providers — validated config, most often. */
  static forRootAsync(options: AsyncModuleOptions<IdempotencyOptions>): DynamicModule {
    const serviceProvider: Provider = {
      provide: IdempotencyService,
      useFactory: async (dataSource: DataSource, ...args: never[]) =>
        new IdempotencyService(dataSource, await options.useFactory(...args)),
      inject: [MORTAR_DATA_SOURCE, ...((options.inject ?? []) as never[])],
    };
    return {
      module: IdempotencyModule,
      imports: (options.imports ?? []) as never[],
      providers: [serviceProvider, IdempotencyInterceptor],
      exports: [serviceProvider, IdempotencyInterceptor],
    };
  }
}
