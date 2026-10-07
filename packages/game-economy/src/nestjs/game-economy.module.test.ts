import { MORTAR_DATA_SOURCE } from '@birtalanrobert/database';
import { describe, expect, it } from 'vitest';
import { GameEconomyModule } from './game-economy.module';
import { GameEconomyService } from './game-economy.service';

describe('GameEconomyModule', () => {
  it('provides and exports the service over mortar’s data source, with the game’s spend order', () => {
    const module = GameEconomyModule.forRoot({ spendOrder: ['grant', 'purchase'] });
    const [provider] = module.providers as Array<{
      provide: unknown;
      inject: unknown[];
      useFactory: (dataSource: unknown) => unknown;
    }>;

    expect(provider!.provide).toBe(GameEconomyService);
    expect(provider!.inject).toEqual([MORTAR_DATA_SOURCE]);
    expect(module.exports).toEqual([provider]);
    expect(provider!.useFactory({})).toBeInstanceOf(GameEconomyService);
  });

  it('refuses at boot an order that would strand a kind of credit', () => {
    const module = GameEconomyModule.forRoot({ spendOrder: ['purchase'] });
    const [provider] = module.providers as Array<{ useFactory: (dataSource: unknown) => unknown }>;
    expect(() => provider!.useFactory({})).toThrow(/spend order/);
  });
});
