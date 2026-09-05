/**
 * The parts that need a database and a container.
 *
 * Separate from the root entry point so that working out a deposit — which a
 * console does while somebody drags a slider — does not drag TypeORM into a
 * browser bundle.
 */
export { PayoutAccount } from './payout-account.entity';
export {
  Payment,
  PaymentRefund,
  type PaymentKind,
  type PaymentMethod,
  type PaymentState,
} from './payment.entity';
export { SavedCard } from './saved-card.entity';
export {
  COMMERCE_PROVIDER,
  CommerceService,
  type CardToSave,
  type RecordPayment,
  type TakenPayment,
  type TakePayment,
} from './commerce.service';
export { CreateCommerce1789800000000 } from '../migrations/1789800000000-CreateCommerce';
export { AddSavedCardsAndKind1790000000000 } from '../migrations/1790000000000-AddSavedCardsAndKind';

import { PayoutAccount } from './payout-account.entity';
import { Payment, PaymentRefund } from './payment.entity';
import { SavedCard } from './saved-card.entity';
import { CreateCommerce1789800000000 } from '../migrations/1789800000000-CreateCommerce';
import { AddSavedCardsAndKind1790000000000 } from '../migrations/1790000000000-AddSavedCardsAndKind';

/** Register with the data source, the way every other mortar package is. */
export const commerceEntities = [PayoutAccount, Payment, PaymentRefund, SavedCard];
export const commerceMigrations = [CreateCommerce1789800000000, AddSavedCardsAndKind1790000000000];
