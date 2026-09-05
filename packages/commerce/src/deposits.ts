/**
 * What a customer has to pay up front, worked out the way a person would check.
 *
 * **Pure, and at the root entry point on purpose.** A console shows "30% of
 * 150,00 lei is 45,00 lei" while somebody drags a slider, and a booking page
 * shows the same number before anybody types a card into it. Neither may reach
 * for a database, and both must arrive at exactly the number the charge will be.
 */

/** How a business asks for money before the work. */
export type DepositKind = 'none' | 'percentage' | 'fixed' | 'full';

export interface DepositPolicy {
  readonly kind: DepositKind;
  /**
   * Whole percent for `percentage`, minor units for `fixed`, ignored otherwise.
   *
   * Whole percent rather than a fraction because it is typed into a box by a
   * person: "30" is what a tattoo studio says, and `0.3` is what turns into
   * `0.30000000000000004` two operations later.
   */
  readonly value: number;
}

/**
 * The deposit for a given total.
 *
 * **Rounded to the nearest minor unit, and never past the total.** A percentage
 * of an odd amount is a fraction of a ban, and a deposit larger than the price
 * is what a misconfigured 150% produces — both are refused here rather than at
 * the provider, where the message is in English and mentions an integer.
 */
export function depositFor(total: number, policy: DepositPolicy): number {
  if (total <= 0) return 0;

  switch (policy.kind) {
    case 'none':
      return 0;
    case 'full':
      return total;
    case 'fixed':
      // A fixed deposit above the price is a configuration mistake, and taking
      // more than the thing costs is the worst possible way to surface it.
      return clamp(Math.round(policy.value), total);
    case 'percentage':
      /*
       * Rounded half away from zero, which is what a person doing it by hand
       * produces. `Math.round` rounds half *up*, which differs on negatives —
       * irrelevant here because a total is never negative, and stated so that
       * the day it is, this is the line to look at.
       */
      return clamp(Math.round((total * clamp(policy.value, 100)) / 100), total);
    default:
      return 0;
  }
}

/** What is still owed after a deposit. Never negative, whatever was paid. */
export const balanceAfter = (total: number, paid: number): number => Math.max(0, total - paid);

const clamp = (value: number, max: number): number => Math.min(Math.max(0, value), max);

/**
 * Whether a business may take money at all.
 *
 * The provider's onboarding is the gate, and it is a hard one: funds go
 * directly to the business and our fee is taken on top, so until the provider
 * has verified who they are there is nowhere for the money to go. Every
 * consumer of this package has to answer the same question in front of the
 * same button, which is why it is here rather than written three times.
 */
export type PayoutStatus = 'none' | 'pending' | 'restricted' | 'ready';

export const canTakeMoney = (status: PayoutStatus): boolean => status === 'ready';

/**
 * What to tell a business that cannot yet, in the order it becomes true.
 *
 * Returned as a key rather than a sentence: the words belong to whichever
 * product is showing them, and a package that shipped English into a Romanian
 * console would be worse than one that shipped nothing.
 */
export const payoutBlockReason = (
  status: PayoutStatus,
): 'not-started' | 'in-progress' | 'needs-attention' | null => {
  switch (status) {
    case 'none':
      return 'not-started';
    case 'pending':
      return 'in-progress';
    case 'restricted':
      return 'needs-attention';
    case 'ready':
      return null;
  }
};
