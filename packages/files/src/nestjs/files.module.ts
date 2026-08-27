import { Global, Module, type DynamicModule, type Provider } from '@nestjs/common';
import type { AsyncModuleOptions } from '@birtalanrobert/context';
import { MORTAR_DATA_SOURCE } from '@birtalanrobert/database';
import type { DataSource } from 'typeorm';
import { FilesService, type FilesServiceOptions } from '../files.service';

export type FilesModuleOptions = FilesServiceOptions;

/**
 * Provides `FilesService` application-wide.
 *
 * Global, like the logger and the workflow module, because uploading is not one
 * feature's concern: the request module stores what a client sent, the delivery
 * module reads it back, and the retention job deletes it. Threading a module
 * import through each of them buys nothing.
 *
 * The storage and scanner ports are constructed by the *application*, not here.
 * Which bucket, which endpoint, which scanner and whether files are encrypted
 * are deployment decisions, and a module that reached for them itself would be
 * reading configuration nothing had validated.
 */
@Global()
@Module({})
export class FilesModule {
  static forRoot(options: FilesModuleOptions): DynamicModule {
    const provider: Provider = {
      provide: FilesService,
      useFactory: (dataSource: DataSource) => new FilesService(dataSource, options),
      inject: [MORTAR_DATA_SOURCE],
    };
    return { module: FilesModule, providers: [provider], exports: [provider] };
  }

  static forRootAsync(options: AsyncModuleOptions<FilesModuleOptions>): DynamicModule {
    const provider: Provider = {
      provide: FilesService,
      useFactory: async (dataSource: DataSource, ...args: never[]) =>
        new FilesService(dataSource, await options.useFactory(...args)),
      inject: [MORTAR_DATA_SOURCE, ...((options.inject ?? []) as never[])],
    };

    return {
      module: FilesModule,
      imports: (options.imports ?? []) as never[],
      providers: [provider],
      exports: [provider],
    };
  }
}
