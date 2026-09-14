import { quantity, type Quantity } from './quantity';
import type { UnitTable } from './table';

/** Why a conversion could not be done. */
export interface ConversionProblem {
  readonly reason: 'unknown-unit' | 'not-base';
  readonly unit: string;
  /** A sentence a person can act on, naming the unit involved. */
  readonly says: string;
}

/**
 * A conversion that worked, or one that did not and why.
 *
 * A discriminated union rather than `undefined` or a throw. Both callers of
 * this package do something specific with a refusal — one turns it into a
 * prompt naming what is missing, the other into a row problem with a line
 * number — and neither can do that with a value that is simply absent.
 */
export type Converted =
  | { readonly ok: true; readonly value: Quantity }
  | { readonly ok: false; readonly problem: ConversionProblem };

const unknown = (unit: string, table: UnitTable): Converted => ({
  ok: false,
  problem: {
    reason: 'unknown-unit',
    unit,
    says: `"${unit}" is not one of the units this is counted in (${table.codes.join(', ')}).`,
  },
});

/** The same quantity in the table's base unit. */
export function toBase(value: Quantity, table: UnitTable): Converted {
  const factor = table.factor(value.unit);
  if (!factor) return unknown(value.unit, table);

  return { ok: true, value: quantity(value.amount.times(factor), table.base) };
}

/**
 * A base-unit quantity expressed in another unit of the same table.
 *
 * Refuses a quantity that is not already in the base unit rather than
 * converting it for you: a caller holding `2 case` and asking to see it in
 * trays has made an arithmetic error somewhere above, and quietly doing the
 * right thing here hides it. `convert` is the function for that.
 */
export function fromBase(base: Quantity, unit: string, table: UnitTable): Converted {
  if (base.unit !== table.base) {
    return {
      ok: false,
      problem: {
        reason: 'not-base',
        unit: base.unit,
        says: `This is in "${base.unit}" rather than in "${table.base}".`,
      },
    };
  }

  const factor = table.factor(unit);
  if (!factor) return unknown(unit, table);

  return { ok: true, value: quantity(base.amount.dividedBy(factor), unit) };
}

/**
 * The same quantity in another unit of the same table.
 *
 * **One multiplication and one division, never a chain.** Every factor in a
 * table is absolute by the time it can be read, so converting a pallet to a
 * bottle does not walk case → tray → bottle accumulating a rounding error at
 * each step. It is the reason the table resolves at definition time.
 */
export function convert(value: Quantity, unit: string, table: UnitTable): Converted {
  if (value.unit === unit) return { ok: true, value };

  const from = table.factor(value.unit);
  if (!from) return unknown(value.unit, table);

  const to = table.factor(unit);
  if (!to) return unknown(unit, table);

  return { ok: true, value: quantity(value.amount.times(from).dividedBy(to), unit) };
}

/** Whether this quantity can be expressed in that unit at all. */
export function canConvert(value: Quantity, unit: string, table: UnitTable): boolean {
  return table.has(value.unit) && table.has(unit);
}
