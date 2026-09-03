/**
 * The parts that need a database and a container.
 *
 * Separate from the root entry point so that counting segments — which a
 * console does on every keystroke — does not drag TypeORM into a browser
 * bundle.
 */
export { MessageCreditEntry, type CreditReason } from './credits.entity';
export { MessageCreditsService, type CreditBalance } from './credits.service';
export { CreateMessageCredits1788390000000 } from '../migrations/1788390000000-CreateMessageCredits';

import { MessageCreditEntry } from './credits.entity';
import { CreateMessageCredits1788390000000 } from '../migrations/1788390000000-CreateMessageCredits';

/** Register with the data source, the way every other mortar package is. */
export const messagingEntities = [MessageCreditEntry];
export const messagingMigrations = [CreateMessageCredits1788390000000];
