import { Decimal } from 'decimal.js';

/**
 * Decimal arithmetic, configured once for every consumer.
 *
 * **Never floating point.** The numbers that pass through this package are
 * factors and the quantities they scale — a case of twenty-four, a tray of six,
 * a density of 1.01 — and they are multiplied together, compounded, and summed.
 * Floating point loses that in the third step and the loss is invisible: every
 * figure renders, every total sums, and the error looks like somebody else's
 * rounding.
 *
 * `decimal.js` rather than a hand-rolled scaled integer, and the reason is the
 * conventions' own test: every justification for writing one — "it must run in
 * the browser", "it must be fast", "we only need four operations" — applies
 * equally to the library, and the library has a decade of edge cases behind it.
 *
 * **Precision is 34 significant digits**, which is IEEE 754 decimal128 and far
 * more than any consumer needs. The point is that intermediate steps never lose
 * anything, because rounding happens once, at the boundary, and never between
 * steps.
 *
 * The configuration is global to `decimal.js` and therefore to the module
 * instance a bundler resolved. That is a real caveat and it has bitten this
 * programme before, with currencies: a consumer that resolves its own copy of
 * `decimal.js` gets that copy's defaults. Declaring `decimal.js` as a **peer**
 * dependency is what keeps one copy in the tree.
 */
Decimal.set({
  precision: 34,
  /*
   * Half-up, which is what everybody outside a bank means by rounding and what
   * every spreadsheet a customer already uses does. Banker's rounding would be
   * defensible and would make a total disagree with the same sum typed into
   * Excel, which is a conversation nobody wants to have about one cent.
   */
  rounding: Decimal.ROUND_HALF_UP,
  /*
   * Never fall back to exponential notation when a value becomes a string:
   * `1e-7` in a JSON response or a CSV export is a number a spreadsheet reads
   * as text.
   */
  toExpNeg: -34,
  toExpPos: 34,
});

export { Decimal };

/** A decimal from anything a caller might reasonably hold. */
export function decimal(value: string | number | Decimal): Decimal {
  return value instanceof Decimal ? value : new Decimal(value);
}

/** Exact zero, for the many places that would otherwise construct one. */
export const ZERO = new Decimal(0);

/**
 * Whether a value is a quantity a consumer will accept.
 *
 * Finite and not negative. A negative quantity is almost always a bug rather
 * than a measurement — a movement's *direction* belongs to its type rather than
 * to the sign of its amount — and allowing one here lets a receipt of −2 kg pass
 * as a waste record nobody can find.
 */
export function isUsableQuantity(value: Decimal): boolean {
  return value.isFinite() && !value.isNegative();
}

/**
 * Strictly greater than zero.
 *
 * **`Decimal.isPositive()` is true for zero.** `decimal.js` keeps a sign on it
 * and +0 is positive by that definition, which is defensible arithmetic and not
 * what any caller has ever meant. Every use of it in this programme meant "is
 * there any of it", and the bug it produced was silent in both directions: an
 * order line for nought packs, a movement of nothing, a price recorded against
 * no quantity.
 *
 * Named rather than written out, because `value.greaterThan(ZERO)` at each site
 * is one paste away from becoming `isPositive()` again.
 */
export function isMoreThanZero(value: Decimal): boolean {
  return value.isFinite() && value.greaterThan(ZERO);
}
