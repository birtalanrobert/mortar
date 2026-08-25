import { Global, Module, type DynamicModule, type Provider } from '@nestjs/common';
import { MORTAR_DATA_SOURCE } from '@mortar/database';
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
}
