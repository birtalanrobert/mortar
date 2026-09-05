/**
 * What a plan costs, and what it lets somebody do.
 *
 * Pure and dependency-free, because a console draws the plan picker and greys
 * out a button while somebody is still typing. Nothing here asks a provider or
 * a database anything.
 *
 * **Designed against all seventeen specifications rather than the one in hand.**
 * They price differently — per location, per active employee, per recruiter
 * seat, per unit with a floor, per ticket, a percentage of transactions, one
 * purchase per wedding, a premium currency in the games — and the *mechanics*
 * underneath every one of them are the same three: a recurring base, a quantity
 * the product counts, and metered usage the product reports.
 */

/** How often the recurring part is charged. */
export type Interval = 'month' | 'year';

/**
 * A band of quantity and what each unit in it costs.
 *
 * Graduated rather than volume: a plan advertised as "up to 5 staff included,
 * then 20 lei each" charges 20 for the sixth, not 20 for all six. Both exist in
 * the wild and only one matches how these products are described.
 */
export interface Tier {
  /** The first quantity this band applies to. The first tier starts at 0. */
  readonly upTo: number | null;
  readonly unitPrice: number;
}

export interface Plan {
  /** Stable across price changes, because it is what a subscription stores. */
  readonly code: string;
  readonly name: string;
  readonly interval: Interval;
  readonly currency: string;
  /** Charged every period whatever the quantity is. Minor units. */
  readonly basePrice: number;
  /** Quantity the base price already covers. */
  readonly includedQuantity: number;
  /**
   * What each further unit costs, in bands.
   *
   * Empty means quantity does not affect the price — a flat plan per location,
   * which several of the seventeen sell.
   */
  readonly tiers: readonly Tier[];
  /**
   * Hard ceilings, by name. `null` is unlimited, and unlimited is a real
   * answer rather than a large number nobody will reach.
   */
  readonly limits: Readonly<Record<string, number | null>>;
  /** What this plan switches on. Absence is the gate; there is no deny list. */
  readonly features: readonly string[];
  /** Days of free use before the first charge. Zero for none. */
  readonly trialDays: number;
}

/**
 * What the recurring part comes to for a given quantity.
 *
 * Rounded per band rather than at the end: a band priced at 3.33 for seven
 * units is charged as seven roundings, which is what an invoice line says and
 * therefore what the total has to agree with.
 */
export function priceFor(plan: Plan, quantity: number): number {
  const billable = Math.max(0, Math.ceil(quantity) - plan.includedQuantity);
  if (billable === 0 || plan.tiers.length === 0) return plan.basePrice;

  let remaining = billable;
  let total = plan.basePrice;
  let floor = plan.includedQuantity;

  for (const tier of plan.tiers) {
    if (remaining <= 0) break;

    const ceiling = tier.upTo === null ? Infinity : tier.upTo;
    const inBand = Math.min(remaining, Math.max(0, ceiling - floor));

    total += Math.round(inBand * tier.unitPrice);
    remaining -= inBand;
    floor = ceiling;
  }

  /*
   * Anything past the last band is charged at the last band's rate.
   *
   * A plan whose final tier has an `upTo` is a plan that silently stops
   * charging for the two-hundredth employee, and nobody notices until the
   * invoice is wrong in our customer's favour for a year.
   */
  if (remaining > 0) {
    const last = plan.tiers.at(-1);
    if (last) total += Math.round(remaining * last.unitPrice);
  }

  return total;
}

/** The ceiling a plan puts on something, or `null` for no ceiling. */
export const limitFor = (plan: Plan, key: string): number | null => plan.limits[key] ?? null;

/**
 * Whether one more is allowed.
 *
 * Takes what is already used rather than a boolean, because "you have used 47
 * of 50" is the message worth showing and it cannot be recovered from "no".
 */
export const withinLimit = (plan: Plan, key: string, used: number): boolean => {
  const limit = limitFor(plan, key);
  return limit === null || used < limit;
};

export const hasFeature = (plan: Plan, feature: string): boolean => plan.features.includes(feature);
