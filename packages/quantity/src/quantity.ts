import { decimal, type Decimal } from './decimal';

/**
 * An amount of something, in a named unit.
 *
 * **The unit travels with the number, always.** A bare number of "grams,
 * probably" is how a system adds 2 kilograms to 500 grams and reports 502, and
 * it is the reason every signature in this package takes a `Quantity` rather
 * than a pair of arguments a caller can transpose.
 */
export interface Quantity {
  readonly amount: Decimal;
  readonly unit: string;
}

/** A quantity from a value and a unit code. The code is not checked here. */
export function quantity(amount: string | number | Decimal, unit: string): Quantity {
  return Object.freeze({ amount: decimal(amount), unit });
}

/** Whether two quantities name the same unit. Amounts are not compared. */
export function sameUnit(a: Quantity, b: Quantity): boolean {
  return a.unit === b.unit;
}
