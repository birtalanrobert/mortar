import { money, type Money } from './money';

/**
 * Splits an amount across weighted shares without losing or inventing a single
 * minor unit.
 *
 * This is the algorithm behind every bill split, fee distribution, discount
 * apportionment and commission calculation in the catalogue. The naive
 * approach — multiply each share by the ratio and round — either loses money
 * or creates it, and the discrepancy always surfaces later as an unexplainable
 * one-cent difference on a reconciliation report.
 *
 * Shares are handed out by integer division, and the remaining units are then
 * distributed one at a time to the largest fractional remainders, ties broken
 * by original position so the result is deterministic and reproducible.
 *
 *   allocate(money(1000, 'EUR'), [1, 1, 1])
 *   // => 334, 333, 333  — sums exactly to 1000
 */
export function allocate(amount: Money, ratios: readonly number[]): Money[] {
  if (ratios.length === 0) throw new Error('allocate() requires at least one ratio');
  if (ratios.some((r) => !Number.isFinite(r) || r < 0)) {
    throw new Error('allocate() ratios must be finite and non-negative');
  }

  const total = ratios.reduce((a, b) => a + b, 0);
  if (total <= 0) throw new Error('allocate() ratios must sum to a positive value');

  const sign = amount.amount < 0 ? -1 : 1;
  const magnitude = Math.abs(amount.amount);

  const exact = ratios.map((r) => (magnitude * r) / total);
  const floors = exact.map((v) => Math.floor(v));
  const distributed = floors.reduce((a, b) => a + b, 0);
  let remainder = magnitude - distributed;

  // Order by descending fractional part, stable on the original index.
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  const result = [...floors];
  for (let i = 0; remainder > 0; i = (i + 1) % order.length) {
    const slot = order[i];
    /* istanbul ignore next -- order is non-empty by construction */
    if (!slot) break;
    result[slot.index] = (result[slot.index] ?? 0) + 1;
    remainder -= 1;
  }

  return result.map((v) => money(sign * v, amount.currency));
}

/**
 * Splits evenly into `parts`, distributing any remainder across the earliest
 * parts. `split(money(1000, 'EUR'), 3)` yields 334, 333, 333.
 */
export function split(amount: Money, parts: number): Money[] {
  if (!Number.isInteger(parts) || parts < 1) {
    throw new Error(`split() requires a positive integer, received: ${parts}`);
  }
  return allocate(amount, new Array<number>(parts).fill(1));
}

/**
 * Distributes an amount proportionally to a set of weights expressed as Money
 * — the shape a bill-by-item split actually arrives in.
 */
export function allocateByAmounts(amount: Money, weights: readonly Money[]): Money[] {
  return allocate(
    amount,
    weights.map((w) => w.amount),
  );
}
