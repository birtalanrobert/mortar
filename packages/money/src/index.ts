export {
  CurrencyMismatchError,
  InvalidAmountError,
  MoneyError,
  ParseError,
  UnknownCurrencyError,
  /* Raised by ./rates, exported here so `instanceof MoneyError` finds them. */
  InvalidRateError,
  RateDirectionError,
} from './errors';

export {
  getCurrency,
  isCurrencyRegistered,
  listCurrencies,
  minorUnitsPerMajor,
  registerCurrency,
  type CurrencyCode,
  type CurrencyDefinition,
} from './currency';

export { DEFAULT_ROUNDING, RoundingMode, roundToInteger } from './rounding';

export {
  abs,
  add,
  compare,
  divide,
  equals,
  fromJSON,
  fromMajor,
  greaterThan,
  greaterThanOrEqual,
  isMoney,
  isNegative,
  isPositive,
  isZero,
  lessThan,
  lessThanOrEqual,
  max,
  min,
  money,
  multiply,
  negate,
  percentage,
  subtract,
  sum,
  toJSON,
  toMajor,
  zero,
  type Money,
  type MoneyJSON,
} from './money';

export { allocate, allocateByAmounts, split } from './allocate';

export { addTax, fromGross, fromNet, removeTax, type TaxedAmount } from './tax';

export { format, parse, type FormatOptions } from './format';

/*
 * Currency **conversion** is not re-exported here: it lives behind
 * `@birtalanrobert/money/rates`.
 *
 * Not a dependency split — this package still has none — but a bundling one.
 * Every console that formats a price imports this barrel, and almost none of
 * them convert between currencies; a barrel that re-exported the rate
 * arithmetic would put it in each of their entry chunks for nothing. The error
 * classes below are the exception, so that `instanceof MoneyError` still finds
 * every error this package can raise.
 */
