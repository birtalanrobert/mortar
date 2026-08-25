import { Global, Module, type DynamicModule, type Provider } from '@nestjs/common';
import { MORTAR_DATA_SOURCE } from '@mortar/database';
import type { DataSource } from 'typeorm';
import { AuditService } from './service';

@Global()
@Module({})
export class AuditModule {
  static forRoot(): DynamicModule {
    const provider: Provider = {
      provide: AuditService,
      useFactory: (dataSource: DataSource) => new AuditService(dataSource),
      inject: [MORTAR_DATA_SOURCE],
    };
    return { module: AuditModule, providers: [provider], exports: [provider] };
  }
}
