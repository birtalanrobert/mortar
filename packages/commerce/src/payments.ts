/**
 * Where a payment is, and what may still be done to it.
 *
 * Pure and dependency-free, because a console renders a refund button from
 * exactly the rule the server enforces — and a screen that offers a refund the
 * server will refuse is a screen that teaches its user not to trust it.
 */

/**
 * How the money arrived.
 *
 * `card` is the only one this package processes. The rest are **recorded, not
 * taken** — and recording them is not a lesser feature: a salon is mostly cash
 * at the counter, a restaurant's till takes meal vouchers, and a box office
 * takes notes. A report that only counts what a provider processed tells a
 * business a fraction of its own takings, which is worse than telling it
 * nothing because it looks complete.
 */
export type PaymentMethod = 'card' | 'cash' | 'terminal' | 'voucher' | 'transfer';

/**
 * Where a payment is.
 *
 * `authorized` is separate from `captured` on purpose: a card held against a
 * no-show fee is authorised and never captured unless the fee is applied, and
 * that decision is a human one.
 */
export type PaymentState =
  | 'pending'
  | 'authorized'
  | 'captured'
  | 'failed'
  | 'refunded'
  | 'partially_refunded'
  | 'cancelled';

/**
 * What a payment was for.
 *
 * Not decoration: a tip belongs to the person who earned it and a product to
 * neither the service nor the diary, so a revenue report that counts all three
 * as service income tells a business its haircuts are more profitable than they
 * are. The distinction has to survive into the row, because it cannot be
 * recovered from an amount afterwards.
 */
export type PaymentKind = 'sale' | 'deposit' | 'fee' | 'tip' | 'product';

/**
 * Whether money actually moved, and so can be given back.
 *
 * A held card has taken nothing yet — releasing it is a different operation
 * with a different name — and a failed charge never will. Both look refundable
 * to anyone reasoning from "there is a payment row here", which is why this is
 * one function and not a condition written twice.
 */
export const isRefundable = (state: PaymentState): boolean =>
  state === 'captured' || state === 'partially_refunded';

/**
 * What is left to give back, in minor units.
 *
 * Takes the two amounts rather than a row, because they arrive as strings from
 * a `bigint` column in one caller and as numbers in another, and the subtraction
 * should not be where that difference is discovered.
 */
export const refundableAmount = (amount: number, refunded: number): number =>
  Math.max(0, amount - refunded);
