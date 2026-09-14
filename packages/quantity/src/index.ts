/**
 * A decimal quantity with a unit, and an explicit factor table.
 *
 * **Pure, and deliberately small.** No framework, no database, no Node
 * built-ins — a browser converting a case to bottles while somebody types has
 * to run this, and so does a worker importing forty thousand products.
 *
 * What it is *for* is the part worth reading. Two products in this programme
 * need "units" and mean different things by it: project 03 converts **between**
 * dimensions using per-ingredient physics — a litre of oil is not a kilogram of
 * oil — and project 04 needs a factor chain **within** one dimension, where a
 * case is four trays and a tray is six bottles. Designed from both, the
 * genuinely shared part is exactly this:
 *
 * - a decimal quantity that carries its unit, never a bare number;
 * - a factor table resolved **at definition time**, so a cycle is impossible by
 *   construction rather than caught at use;
 * - conversion to and from a base unit, with the arithmetic done once;
 * - a structured refusal when a conversion is not defined — a sentence naming
 *   what is missing, not an exception with a stack trace.
 *
 * What is deliberately **not** here: densities and piece weights, which are
 * project 03's and meaningless to a wholesaler; minimum order quantities and
 * increments, which are project 04's and meaningless to a kitchen; and anything
 * at all that knows what a product is.
 */

export { Decimal, decimal, isMoreThanZero, isUsableQuantity, ZERO } from './decimal';
export { quantity, sameUnit, type Quantity } from './quantity';
export {
  unitTable,
  UnitTableError,
  type UnitSpec,
  type UnitTable,
  type UnitTableProblem,
} from './table';
export {
  canConvert,
  convert,
  fromBase,
  toBase,
  type ConversionProblem,
  type Converted,
} from './convert';
