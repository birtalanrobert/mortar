import { getCurrency, minorUnitsPerMajor, type CurrencyCode } from './currency';
import { CurrencyMismatchError, InvalidAmountError } from './errors';
import { DEFAULT_ROUNDING, RoundingMode, roundToInteger } from './rounding';

/**
 * A monetary amount, held as an integer number of minor units.
 *
 * Never a float. Never a bare number passed around without its currency.
 * `amount` is a safe integer: 9,007,199,254,740,991 minor units is roughly
 * ninety trillion euros, which is comfortably beyond anything these systems
 * will ever hold, and keeping it a number rather than a bigint means Money
 * serialises to JSON without ceremony.
 */
export interface Money {
  readonly amount: number;
  readonly currency: CurrencyCode;
}

function assertValidAmount(amount: number): void {
  if (!Number.isSafeInteger(amount)) throw new InvalidAmountError(amount);
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
}

/** Constructs Money from an integer number of minor units. */
export function money(amount: number, currency: CurrencyCode): Money {
  assertValidAmount(amount);
  const definition = getCurrency(currency);
  return Object.freeze({ amount, currency: definition.code });
}

/**
 * Constructs Money from a major-unit value, e.g. `fromMajor(12.34, 'EUR')`.
 *
 * The input is a float and is therefore rounded to the currency's precision;
 * this is the only place in the library where a float is accepted, and it
 * exists because user input and third-party payloads arrive that way.
 */
export function fromMajor(
  value: number,
  currency: CurrencyCode,
  mode: RoundingMode = DEFAULT_ROUNDING,
): Money {
  if (!Number.isFinite(value)) throw new InvalidAmountError(value);
  const factor = minorUnitsPerMajor(currency);
  return money(roundToInteger(value * factor, mode), currency);
}

/**
 * Converts to a major-unit number.
 *
 * Lossy by nature — for display and for handing to third-party APIs that
 * insist on decimals. Never round-trip through this for arithmetic.
 */
export function toMajor(m: Money): number {
  return m.amount / minorUnitsPerMajor(m.currency);
}

/** Zero in the given currency. */
export function zero(currency: CurrencyCode): Money {
  return money(0, currency);
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount + b.amount, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount - b.amount, a.currency);
}

export function negate(m: Money): Money {
  return money(-m.amount, m.currency);
}

export function abs(m: Money): Money {
  return money(Math.abs(m.amount), m.currency);
}

/** Multiplies by a scalar, rounding the result to whole minor units. */
export function multiply(m: Money, factor: number, mode: RoundingMode = DEFAULT_ROUNDING): Money {
  if (!Number.isFinite(factor)) throw new InvalidAmountError(factor);
  return money(roundToInteger(m.amount * factor, mode), m.currency);
}

/** Divides by a scalar, rounding the result to whole minor units. */
export function divide(m: Money, divisor: number, mode: RoundingMode = DEFAULT_ROUNDING): Money {
  if (!Number.isFinite(divisor) || divisor === 0) throw new InvalidAmountError(divisor);
  return money(roundToInteger(m.amount / divisor, mode), m.currency);
}

/**
 * Applies a percentage, e.g. `percentage(price, 19)` for 19%.
 *
 * Expressed in percent rather than as a fraction because that is how discounts,
 * fees, commissions and tax rates are written on every contract these systems
 * will ever read, and translating at the call site invites errors.
 */
export function percentage(
  m: Money,
  percent: number,
  mode: RoundingMode = DEFAULT_ROUNDING,
): Money {
  return multiply(m, percent / 100, mode);
}

/** -1 if a < b, 0 if equal, 1 if a > b. Throws on currency mismatch. */
export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.amount < b.amount) return -1;
  if (a.amount > b.amount) return 1;
  return 0;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amount === b.amount;
}

export const lessThan = (a: Money, b: Money): boolean => compare(a, b) < 0;
export const lessThanOrEqual = (a: Money, b: Money): boolean => compare(a, b) <= 0;
export const greaterThan = (a: Money, b: Money): boolean => compare(a, b) > 0;
export const greaterThanOrEqual = (a: Money, b: Money): boolean => compare(a, b) >= 0;

export const isZero = (m: Money): boolean => m.amount === 0;
export const isPositive = (m: Money): boolean => m.amount > 0;
export const isNegative = (m: Money): boolean => m.amount < 0;

export function min(...values: Money[]): Money {
  if (values.length === 0) throw new Error('min() requires at least one value');
  return values.reduce((acc, v) => (compare(v, acc) < 0 ? v : acc));
}

export function max(...values: Money[]): Money {
  if (values.length === 0) throw new Error('max() requires at least one value');
  return values.reduce((acc, v) => (compare(v, acc) > 0 ? v : acc));
}

/**
 * Sums a list. The currency is taken from the first element, so an empty list
 * requires an explicit currency to be meaningful.
 */
export function sum(values: readonly Money[], currency?: CurrencyCode): Money {
  if (values.length === 0) {
    if (!currency) throw new Error('sum() of an empty list requires an explicit currency');
    return zero(currency);
  }
  return values.reduce((acc, v) => add(acc, v));
}

/** A stable wire representation, safe to store and to send over HTTP. */
export interface MoneyJSON {
  amount: number;
  currency: string;
}

export function toJSON(m: Money): MoneyJSON {
  return { amount: m.amount, currency: m.currency };
}

export function fromJSON(value: MoneyJSON): Money {
  return money(value.amount, value.currency);
}

/** Type guard for values arriving from outside the type system. */
export function isMoney(value: unknown): value is Money {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Money).amount === 'number' &&
    typeof (value as Money).currency === 'string'
  );
}
