/**
 * Our own revenue: what a business pays *us*.
 *
 * **Not to be confused with `@birtalanrobert/commerce`**, which is the other
 * direction — a business taking money from its own customers through Connect,
 * with the funds never touching us. They differ in who pays whom, in which
 * account, in our liability, and in what happens when one fails. Conflating
 * them is the mistake that makes both hard to reason about.
 *
 * **This entry point is pure**, and stays that way by leaving things out. What
 * a plan costs, whether a subscription entitles anybody to anything, and how
 * hard to push about an unpaid invoice are all decided without a database or a
 * provider — because a console shows a plan picker and greys out a button while
 * somebody is still typing. Storage and the container are behind `/nestjs`; the
 * Stripe client is behind `/stripe`, because a barrel that re-exports a vendor
 * SDK puts the whole thing into every bundle that wanted to multiply two
 * numbers.
 */
export {
  hasFeature,
  limitFor,
  priceFor,
  withinLimit,
  type Interval,
  type Plan,
  type Tier,
} from './plans';

export {
  canCommit,
  dunningStage,
  isEntitled,
  proratedFor,
  type DunningStage,
  type SubscriptionStatus,
} from './subscriptions';

export { mayUse, usageCost, type OverageBehaviour, type UsageRate } from './usage';

export { NoBilling } from './providers/none';

export type {
  BillingEvent,
  BillingProvider,
  CheckoutRequest,
  HostedSession,
  ProviderCustomer,
  ProviderSubscription,
} from './providers/port';
