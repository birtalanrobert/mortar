/**
 * Taking money on a business's behalf.
 *
 * **We never hold anybody's funds.** The customer pays the business directly
 * and our fee is taken on top as an application fee — a hard architectural rule
 * rather than a preference, because holding third-party money turns a software
 * company into a regulated payments business. Every design decision here
 * follows from it.
 *
 * Not to be confused with `@birtalanrobert/billing`, which is the other
 * direction: the business paying *us* for a subscription. Conflating the two is
 * the mistake that makes both hard to reason about — they differ in who pays
 * whom, in which Stripe account, and in what happens when one fails.
 *
 * **This entry point is pure.** What a deposit comes to and whether a business
 * may sell yet are decided without a database or a provider, because a console
 * shows both while somebody drags a slider. Everything needing storage or
 * somebody else's money-moving licence is behind `/nestjs`.
 */
export {
  balanceAfter,
  canTakeMoney,
  depositFor,
  payoutBlockReason,
  type DepositKind,
  type DepositPolicy,
  type PayoutStatus,
} from './deposits';

export {
  isRefundable,
  refundableAmount,
  type PaymentKind,
  type PaymentMethod,
  type PaymentState,
} from './payments';

export type {
  ChargeRequest,
  ChargeResult,
  OnboardingLink,
  PaymentProvider,
  ProviderAccount,
  ProviderEvent,
  RefundRequest,
  SaveCardRequest,
  SaveCardResult,
  StoredCard,
} from './providers/port';

export { StripeConnect, type StripeConnectOptions } from './providers/stripe';
