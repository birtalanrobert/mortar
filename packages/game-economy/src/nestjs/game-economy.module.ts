import { Global, Module, type DynamicModule, type Provider } from '@nestjs/common';
import { MORTAR_DATA_SOURCE } from '@birtalanrobert/database';
import type { DataSource } from 'typeorm';
import type { GameEconomyOptions } from './game-economy-options.types';
import { GameEconomyService } from './game-economy.service';

/**
 * Provides the ledger application-wide, over mortar's `DataSource` — so its
 * writes join the transactions the game's own services open.
 */
@Global()
@Module({})
export class GameEconomyModule {
  static forRoot(options: GameEconomyOptions): DynamicModule {
    const provider: Provider = {
      provide: GameEconomyService,
      useFactory: (dataSource: DataSource) => new GameEconomyService(dataSource, options),
      inject: [MORTAR_DATA_SOURCE],
    };
    return { module: GameEconomyModule, providers: [provider], exports: [provider] };
  }
}
