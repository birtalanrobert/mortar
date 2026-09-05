/**
 * Metered usage, and what it comes to.
 *
 * Four of the seventeen bill something they count — tickets sold, text messages
 * sent, a percentage of what passed through a till — on top of a subscription.
 * The counting belongs to the product; the arithmetic and the shape of the
 * record belong here.
 */

/** One thing worth charging for, as the product names it. */
export interface UsageRate {
  /** What is counted: `ticket`, `sms_segment`, `order_value`. */
  readonly meter: string;
  /** Included in the plan each period, before anything is charged. */
  readonly included: number;
  /** Minor units per unit counted. */
  readonly unitPrice: number;
}

/**
 * What a period's usage costs, after the allowance.
 *
 * The allowance is per period and does not roll over — which is a commercial
 * decision, stated here because the alternative is somebody discovering it in
 * the arithmetic.
 */
export const usageCost = (rate: UsageRate, used: number): number =>
  Math.round(Math.max(0, used - rate.included) * rate.unitPrice);

/**
 * What to do when the allowance runs out.
 *
 * The tenant's choice, not ours. A salon that would rather stop sending than be
 * charged is making a reasonable decision about its own margin, and a product
 * that silently auto-tops-up is one that appears on a card statement as a
 * surprise.
 */
export type OverageBehaviour = 'block' | 'charge';

/** Whether one more unit may be spent right now. */
export const mayUse = (
  rate: UsageRate,
  used: number,
  behaviour: OverageBehaviour,
  balance = 0,
): boolean => (used < rate.included ? true : behaviour === 'charge' || balance > 0);
