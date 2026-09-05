/**
 * The parts that need a database and a container.
 *
 * Separate from the root entry point so that pricing a plan — which a console
 * does while somebody chooses one — does not drag TypeORM into a browser
 * bundle. The Stripe client is separate again, behind `/stripe`.
 */
export { BillingPlan } from './plan.entity';
export { Subscription } from './subscription.entity';
export { UsageRecord } from './usage-record.entity';
export { BILLING_PROVIDER, BillingService, type Standing } from './billing.service';
export { CreateBilling1790200000000 } from '../migrations/1790200000000-CreateBilling';

import { BillingPlan } from './plan.entity';
import { Subscription } from './subscription.entity';
import { UsageRecord } from './usage-record.entity';
import { CreateBilling1790200000000 } from '../migrations/1790200000000-CreateBilling';

/** Register with the data source, the way every other mortar package is. */
export const billingEntities = [BillingPlan, Subscription, UsageRecord];
export const billingMigrations = [CreateBilling1790200000000];
