/**
 * Where a subscription stands, and what the product should do about it.
 *
 * The decisions here are commercial rather than technical, and getting them
 * wrong is expensive in both directions: too strict and a salon loses its diary
 * over a card that expired on a Sunday; too lax and a business runs free for
 * months. Both are decided by pure functions so that a console, an API guard
 * and a nightly job cannot disagree about the answer.
 */

/**
 * What the provider says about a subscription.
 *
 * `paused` is ours rather than a provider's: a seasonal business — a wedding
 * venue in February, a driving instructor in August — asks to stop paying
 * without losing anything, and the alternative they take otherwise is
 * cancelling.
 */
export type SubscriptionStatus =
  'trialing' | 'active' | 'past_due' | 'paused' | 'cancelled' | 'none';

/**
 * Whether the product should work at all.
 *
 * **`past_due` is entitled, deliberately.** A card expires on a Sunday and
 * nobody sees the email until Tuesday; a salon whose diary stopped in between
 * has lost bookings it cannot recover, over an amount it fully intended to pay.
 * Dunning escalates in `dunningStage`; this is the switch, and it stays on
 * until dunning says otherwise.
 */
export const isEntitled = (status: SubscriptionStatus): boolean =>
  status === 'trialing' || status === 'active' || status === 'past_due';

/**
 * Whether *new* commitments may be made.
 *
 * The distinction that keeps a lapse from being a catastrophe: an unpaid
 * business keeps everything it has and can still run today, but stops
 * accumulating work we would then have to hand back. Which acts count is the
 * product's decision; whether it may is this one.
 */
export const canCommit = (status: SubscriptionStatus): boolean =>
  status === 'trialing' || status === 'active';

/** What to do about an unpaid subscription, and when. */
export type DunningStage = 'none' | 'remind' | 'warn' | 'restrict' | 'suspend';

/**
 * How hard to push, by how long it has been unpaid.
 *
 * Days rather than attempts, because a customer experiences time and not
 * retries. The shape is deliberately slow: the overwhelming majority of failed
 * payments are an expired card, and the business intends to pay.
 *
 * `suspend` never deletes anything. It withholds the service; the data belongs
 * to the customer and is theirs to export on the day they leave.
 */
export function dunningStage(daysPastDue: number): DunningStage {
  if (daysPastDue < 1) return 'none';
  if (daysPastDue < 4) return 'remind';
  if (daysPastDue < 8) return 'warn';
  if (daysPastDue < 15) return 'restrict';
  return 'suspend';
}

/**
 * What a business is charged for a period it only partly used.
 *
 * Straight-line by day, and **rounded down**, because the alternative is
 * explaining a rounding to somebody who is already unhappy about a change they
 * did not expect. Never negative: a downgrade produces a credit, which is a
 * different operation with a different name.
 */
export function proratedFor(amount: number, daysUsed: number, daysInPeriod: number): number {
  if (daysInPeriod <= 0) return 0;
  const used = Math.min(Math.max(daysUsed, 0), daysInPeriod);
  return Math.max(0, Math.floor((amount * used) / daysInPeriod));
}
