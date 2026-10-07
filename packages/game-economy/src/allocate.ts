import type { CreditKind } from './kinds';
import type { Draw, Lot } from './types';

/**
 * Which credits a debit of `amount` draws on: the kinds in `order`, and within
 * a kind the oldest first, each as far as it goes — or null when everything
 * left is less than asked, so a debit is all or nothing.
 *
 * Pure, so the rule that decides refundability can be read and tested without
 * a database, and shown in a console before anything is spent.
 */
export function allocate(
  lots: readonly Lot[],
  amount: number,
  order: readonly CreditKind[],
): Draw[] | null {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new RangeError(`A debit is a whole, positive amount; received ${amount}.`);
  }
  const ranked = [...lots]
    .filter((lot) => lot.remaining > 0)
    .sort(
      (one, other) => order.indexOf(one.kind) - order.indexOf(other.kind) || one.seq - other.seq,
    );
  const draws: Draw[] = [];
  let left = amount;
  for (const lot of ranked) {
    if (left === 0) break;
    const taken = Math.min(lot.remaining, left);
    draws.push({ lotId: lot.id, amount: taken });
    left -= taken;
  }
  return left === 0 ? draws : null;
}
