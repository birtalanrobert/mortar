import { CreateGameEconomy1791401023940 } from '../migrations/1791401023940-CreateGameEconomy';
import { AddReversals1791548064129 } from '../migrations/1791548064129-AddReversals';
import { EconomyBalance } from './economy-balance.entity';
import { EconomyDraw } from './economy-draw.entity';
import { EconomyEntry } from './economy-entry.entity';
import { EconomyLot } from './economy-lot.entity';

export { EconomyBalance, EconomyDraw, EconomyEntry, EconomyLot };
export { AddReversals1791548064129, CreateGameEconomy1791401023940 };
export { GameEconomyModule } from './game-economy.module';
export { GameEconomyService } from './game-economy.service';
export type { GameEconomyOptions } from './game-economy-options.types';
export type { MovementRequest, RefundRequest } from './movement-request.types';
export type { EntryView, LotView, Reconciliation, Reversal } from './economy-views';

/** Register alongside the project's own entities. */
export const gameEconomyEntities = [EconomyEntry, EconomyBalance, EconomyLot, EconomyDraw];

/** Register alongside the project's own migrations. */
export const gameEconomyMigrations = [CreateGameEconomy1791401023940, AddReversals1791548064129];
