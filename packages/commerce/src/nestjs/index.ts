/**
 * The parts that need a database and a container.
 *
 * Separate from the root entry point so that working out a deposit — which a
 * console does while somebody drags a slider — does not drag TypeORM into a
 * browser bundle.
 */
export { PayoutAccount } from './payout-account.entity';
export { Payment, PaymentRefund, type PaymentMethod, type PaymentState } from './payment.entity';
export {
  COMMERCE_PROVIDER,
  CommerceService,
  type RecordPayment,
  type TakePayment,
} from './commerce.service';
export { CreateCommerce1789800000000 } from '../migrations/1789800000000-CreateCommerce';

import { PayoutAccount } from './payout-account.entity';
import { Payment, PaymentRefund } from './payment.entity';
import { CreateCommerce1789800000000 } from '../migrations/1789800000000-CreateCommerce';

/** Register with the data source, the way every other mortar package is. */
export const commerceEntities = [PayoutAccount, Payment, PaymentRefund];
export const commerceMigrations = [CreateCommerce1789800000000];
