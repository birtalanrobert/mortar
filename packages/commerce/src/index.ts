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
 * **This entry point is pure**, and stays that way by leaving things out. What
 * a deposit comes to and whether a business may sell yet are decided without a
 * database or a provider, because a console shows both while somebody drags a
 * slider. Storage and the container are behind `/nestjs`; the Stripe client is
 * behind `/stripe`, because a barrel that re-exports it puts the vendor's whole
 * SDK into every bundle that wanted to divide a price by three.
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

export { NoPayments } from './providers/none';

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

/*
 * `StripeConnect` is deliberately NOT re-exported here.
 *
 * It lives at `@birtalanrobert/commerce/stripe`, because importing it pulls in
 * the vendor's whole SDK — and this entry point is imported by browser code
 * that only wants to know what a deposit comes to. Re-exporting it put 30 KB of
 * a payments SDK into a console's first load for a screen that never calls it:
 * a barrel is a bundling decision, and the only way to keep this one pure is to
 * leave the heavy thing out of it.
 */
