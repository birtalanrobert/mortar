import { Global, Module, type DynamicModule, type Provider } from '@nestjs/common';
import type { AsyncModuleOptions } from '@birtalanrobert/context';
import { MORTAR_DATA_SOURCE } from '@birtalanrobert/database';
import type { DataSource } from 'typeorm';
import { WalletRegistrationsService } from './registrations.service';
import {
  WALLET_OPTIONS,
  WALLET_PASS_SOURCE,
  WalletWebService,
  type WalletModuleOptions,
} from './web-service';

export { WalletRegistrationsService } from './registrations.service';
export {
  WALLET_OPTIONS,
  WALLET_PASS_SOURCE,
  WalletWebService,
  type WalletModuleOptions,
} from './web-service';
export { WalletDeviceLog, WalletPushDelivery, WalletRegistration } from './entities';

import { WalletDeviceLog, WalletPushDelivery, WalletRegistration } from './entities';
import { CreateWalletRegistrations1789700000000 } from '../migrations/1789700000000-CreateWalletRegistrations';

export { CreateWalletRegistrations1789700000000 };

/**
 * Everything the consuming service must register with TypeORM.
 *
 * Arrays rather than individual exports, so an application lists one name per
 * package instead of importing entities one at a time and discovering a missing
 * one at run time.
 */
export const walletEntities = [WalletRegistration, WalletPushDelivery, WalletDeviceLog];
export const walletMigrations = [CreateWalletRegistrations1789700000000];

/**
 * The update web service's services, provided application-wide.
 *
 * Global, because three unrelated parts of a product reach for them: the
 * controller serving Apple's devices, the worker pushing after a change, and
 * the back office reading what happened. Threading a module import through each
 * buys nothing.
 *
 * **The routes are not here.** `WalletWebService` carries the five handlers and
 * no HTTP decorators, and the product writes the controller — because where
 * they live, which guard marks them public and what rate limit they carry are
 * the product's decisions, and expressing any of them here would mean depending
 * on the product's authentication.
 */
@Global()
@Module({})
export class WalletModule {
  static forRoot(options: WalletModuleOptions, passSource: Provider): DynamicModule {
    return WalletModule.build({ provide: WALLET_OPTIONS, useValue: options }, passSource, []);
  }

  static forRootAsync(
    options: AsyncModuleOptions<WalletModuleOptions>,
    passSource: Provider,
  ): DynamicModule {
    return WalletModule.build(
      {
        provide: WALLET_OPTIONS,
        useFactory: options.useFactory,
        inject: (options.inject ?? []) as never[],
      },
      passSource,
      (options.imports ?? []) as never[],
    );
  }

  private static build(
    optionsProvider: Provider,
    passSource: Provider,
    imports: never[],
  ): DynamicModule {
    const registrations: Provider = {
      provide: WalletRegistrationsService,
      useFactory: (dataSource: DataSource) => new WalletRegistrationsService(dataSource),
      inject: [MORTAR_DATA_SOURCE],
    };

    return {
      module: WalletModule,
      imports,
      providers: [optionsProvider, passSource, registrations, WalletWebService],
      exports: [WalletWebService, registrations, WALLET_PASS_SOURCE],
    };
  }
}
