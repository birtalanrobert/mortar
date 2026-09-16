import { minorUnitsPerMajor, getCurrency, type CurrencyCode } from './currency';
import { InvalidRateError, RateDirectionError } from './errors';
import { DEFAULT_ROUNDING, RoundingMode } from './rounding';
import { money, type Money } from './money';

/**
 * Decimal places a rate is held to.
 *
 * Ten, which is more than any central bank publishes — the BNR quotes four, the
 * ECB four or five, the MNB between two and six — and the same precision a
 * `numeric(20, 10)` column holds, so a rate survives the round trip through a
 * database without a conversation about what got lost.
 *
 * Fixed rather than per-rate. A scale carried on each value would make two
 * rates for the same pair incomparable without normalising first, and the whole
 * point of an integer representation is that comparison is `===`.
 */
export const RATE_SCALE = 10;

const SCALE_FACTOR = 10n ** BigInt(RATE_SCALE);

/**
 * One currency priced in another, on a stated day.
 *
 * **Direction is part of the value, not a convention the caller remembers.**
 * `base` is what one unit of is being priced and `quote` is what it is priced
 * in: a BNR rate of 4.9772 is `base: 'EUR', quote: 'RON'`, and it says that one
 * euro costs 4.9772 lei. Getting this backwards is the commonest bug in
 * currency code and the reason `convert` refuses a mismatch instead of guessing.
 *
 * `rate` is an integer scaled by `10 ** RATE_SCALE` — never a float. A rate is
 * multiplied by an amount and then divided, and a float would put a rounding
 * error into the middle of that, where nothing can find it afterwards.
 */
export interface ExchangeRate {
  readonly base: CurrencyCode;
  readonly quote: CurrencyCode;

  /** Quote units per one base unit, scaled by `10 ** RATE_SCALE`. */
  readonly rate: number;

  /**
   * The **calendar day** the rate was published for, as `YYYY-MM-DD`.
   *
   * A date rather than an instant, and a string rather than a `Date`, because
   * that is what it is: the BNR publishes one rate for Tuesday, not a rate at
   * 13:00 Bucharest time. A `Date` would carry a timezone nobody meant, and the
   * same rate would be Monday's or Tuesday's depending on where the process
   * runs — which is exactly the sort of difference that shows up as a one-day
   * discrepancy in a year-end reconciliation.
   *
   * ISO-8601 dates also sort correctly as strings, which is what `rateOn`
   * relies on.
   */
  readonly asOf?: string;

  /** Who published it — 'BNR', 'ECB', 'MNB'. Kept so a figure can be defended. */
  readonly source?: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Builds a rate from a decimal string, exactly.
 *
 * A **string** is the primary input because that is what a central bank
 * publishes and what a `numeric` column returns, and because `0.1 + 0.2` is the
 * reason no rate in this library is ever a float. A `number` is accepted for
 * the cases where one is genuinely all there is, and is converted through its
 * own decimal representation rather than by multiplying.
 */
export function rate(
  base: CurrencyCode,
  quote: CurrencyCode,
  value: string | number,
  meta: { asOf?: string; source?: string } = {},
): ExchangeRate {
  const baseDefinition = getCurrency(base);
  const quoteDefinition = getCurrency(quote);

  if (meta.asOf !== undefined && !ISO_DATE.test(meta.asOf)) {
    throw new InvalidRateError(meta.asOf, 'asOf must be a calendar date, as YYYY-MM-DD');
  }

  return Object.freeze({
    base: baseDefinition.code,
    quote: quoteDefinition.code,
    rate: parseScaled(value),
    ...(meta.asOf === undefined ? {} : { asOf: meta.asOf }),
    ...(meta.source === undefined ? {} : { source: meta.source }),
  });
}

/**
 * The rate as a decimal string, with trailing zeros trimmed.
 *
 * Lossless, and the form to write into a `numeric` column or onto a document
 * that has to justify a figure. `toMajor`'s warning applies to the float form
 * and not to this one — there is no float here.
 */
export function rateToString(value: ExchangeRate): string {
  const scaled = BigInt(value.rate);
  const whole = scaled / SCALE_FACTOR;
  const fraction = (scaled % SCALE_FACTOR).toString().padStart(RATE_SCALE, '0').replace(/0+$/, '');

  return fraction.length === 0 ? whole.toString() : `${whole.toString()}.${fraction}`;
}

/**
 * The same rate the other way round.
 *
 * **Lossy, and explicitly so.** 1 / 4.9772 is 0.2009161… and ten decimal places
 * is where it stops; converting there and back does not return the amount you
 * started with. That is a property of division and not a defect here, but it is
 * the reason this is a function somebody has to call rather than something
 * `convert` does quietly when the currencies do not line up.
 *
 * Where both directions matter — a ledger that has to reconcile — store the
 * published direction and convert once, rather than inverting and hoping.
 */
export function invert(value: ExchangeRate): ExchangeRate {
  if (value.rate === 0) throw new InvalidRateError(0, 'a zero rate cannot be inverted');

  const inverted = divideRounded(SCALE_FACTOR * SCALE_FACTOR, BigInt(value.rate), DEFAULT_ROUNDING);

  return Object.freeze({
    base: value.quote,
    quote: value.base,
    rate: toSafeInteger(inverted),
    ...(value.asOf === undefined ? {} : { asOf: value.asOf }),
    ...(value.source === undefined ? {} : { source: value.source }),
  });
}

/**
 * Converts an amount into the rate's quote currency.
 *
 * **Through major units, not minor ones.** 45000 minor EUR times 4.9772 is the
 * right answer in minor RON only because both currencies happen to have two
 * decimal places. Convert to a currency with none — JPY, ISK, HUF as some
 * systems still treat it — and the naive arithmetic is out by a factor of a
 * hundred, silently, in whichever direction. The minor-unit ratio is in here
 * precisely so that no caller has to remember it.
 *
 * The whole calculation is done in `bigint` and rounded once at the end.
 * A million euros in minor units times a rate scaled by ten decimal places is
 * about 2 × 10^18, which is two hundred times past the largest integer a
 * JavaScript number represents exactly — so a `number` here would not merely
 * round, it would round somewhere unpredictable.
 */
export function convert(
  amount: Money,
  value: ExchangeRate,
  mode: RoundingMode = DEFAULT_ROUNDING,
): Money {
  if (amount.currency !== value.base) {
    throw new RateDirectionError(amount.currency, value.base, value.quote);
  }

  const converted = divideRounded(
    BigInt(amount.amount) * BigInt(value.rate) * BigInt(minorUnitsPerMajor(value.quote)),
    SCALE_FACTOR * BigInt(minorUnitsPerMajor(value.base)),
    mode,
  );

  return money(toSafeInteger(converted), value.quote);
}

/**
 * The exact rational that takes an amount in base minor units to quote minor
 * units.
 *
 * For callers holding a value this library's `Money` cannot represent — a price
 * *per gram*, a fractional count of minor units, anything carried in a decimal
 * type of the caller's own. `convert` is the right function for an amount; this
 * is for a coefficient, and it exists so that nobody re-derives the minor-unit
 * ratio by hand, which is the mistake `convert` was written to prevent.
 *
 * Exact and safe to hold in a JavaScript number: the numerator is the rate
 * (at most about 10^15 for any rate this library accepts) times the quote's
 * minor units, and the denominator is `10 ** RATE_SCALE` times the base's.
 * Multiply first and divide second, in whatever decimal type you have — doing
 * it the other way round throws away the precision this is here to preserve.
 *
 * ```ts
 * const { numerator, denominator } = conversionFactor(bnr);
 * const inRon = perGramInEur.times(numerator).dividedBy(denominator);
 * ```
 */
export function conversionFactor(value: ExchangeRate): {
  readonly numerator: number;
  readonly denominator: number;
} {
  return Object.freeze({
    numerator: toSafeInteger(BigInt(value.rate) * BigInt(minorUnitsPerMajor(value.quote))),
    denominator: toSafeInteger(SCALE_FACTOR * BigInt(minorUnitsPerMajor(value.base))),
  });
}

/**
 * The rate that applied on a given day: the latest published **on or before**
 * it.
 *
 * This is the whole convention, and it is not a nicety. Central banks publish
 * on working days; rent falls due on the first of the month, which is a Sunday
 * four times a year and a public holiday more often than that. A lookup
 * demanding an exact match would fail on precisely those days, and a lookup
 * taking the nearest in either direction would use a rate published after the
 * event — a figure that changes depending on when the report is run, which is
 * the one thing a settled amount must never do.
 *
 * Rates with no `asOf` are ignored: a rate that does not say when it applied
 * cannot answer a question about a particular day.
 */
export function rateOn(
  rates: readonly ExchangeRate[],
  pair: { base: CurrencyCode; quote: CurrencyCode },
  on: string,
): ExchangeRate | undefined {
  if (!ISO_DATE.test(on)) {
    throw new InvalidRateError(on, 'a lookup date must be a calendar date, as YYYY-MM-DD');
  }

  let best: ExchangeRate | undefined;

  for (const candidate of rates) {
    if (candidate.base !== pair.base || candidate.quote !== pair.quote) continue;
    if (candidate.asOf === undefined || candidate.asOf > on) continue;
    // String comparison, because ISO-8601 dates sort chronologically as text.
    if (best?.asOf !== undefined && candidate.asOf <= best.asOf) continue;
    best = candidate;
  }

  return best;
}

/**
 * Parses a decimal string into an integer scaled by `10 ** RATE_SCALE`.
 *
 * Hand-written rather than routed through `Number`, because the entire point is
 * to not go through a float: `Number('1.005')` is 1.00499999999999989, and
 * multiplying that by 10^10 gives a rate one unit short of the one that was
 * published.
 */
function parseScaled(value: string | number): number {
  const text = typeof value === 'number' ? decimalStringOf(value) : value.trim();

  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) {
    throw new InvalidRateError(value, 'expected a positive decimal number');
  }

  const [, whole = '0', fraction = ''] = match;

  if (fraction.length > RATE_SCALE) {
    throw new InvalidRateError(
      value,
      `more than ${RATE_SCALE} decimal places, which this library cannot hold exactly`,
    );
  }

  const scaled = BigInt(whole + fraction.padEnd(RATE_SCALE, '0'));
  if (scaled === 0n) throw new InvalidRateError(value, 'a rate cannot be zero');

  return toSafeInteger(scaled);
}

/**
 * A number's own decimal representation, refusing exponential notation.
 *
 * `String(1e-7)` is `'1e-7'`, which the parser above would reject with a
 * confusing message; saying so here names the actual problem.
 */
function decimalStringOf(value: number): string {
  if (!Number.isFinite(value)) throw new InvalidRateError(value, 'not a finite number');

  const text = String(value);
  if (text.includes('e') || text.includes('E')) {
    throw new InvalidRateError(value, 'exponential notation — pass the rate as a decimal string');
  }

  return text;
}

function toSafeInteger(value: bigint): number {
  const asNumber = Number(value);
  if (!Number.isSafeInteger(asNumber)) {
    throw new InvalidRateError(
      value.toString(),
      'out of the range this library represents exactly',
    );
  }
  return asNumber;
}

/**
 * Integer division with a rounding mode, on `bigint`.
 *
 * `roundToInteger` exists for the same job on `number`, and cannot be used
 * here: the quotient is formed by dividing two values either of which may be
 * far past the exactly-representable range, so the remainder has to be carried
 * rather than inferred from a float that has already lost it.
 */
function divideRounded(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator === 0n) throw new InvalidRateError(0, 'division by zero');

  /* Normalised so the remainder below is always non-negative. */
  const signedNumerator = denominator < 0n ? -numerator : numerator;
  const divisor = denominator < 0n ? -denominator : denominator;

  const negative = signedNumerator < 0n;
  const magnitude = negative ? -signedNumerator : signedNumerator;

  const quotient = magnitude / divisor;
  const remainder = magnitude % divisor;

  if (remainder === 0n) return negative ? -quotient : quotient;

  /* Doubled, so a tie is `twice === divisor` with no fraction anywhere. */
  const twice = remainder * 2n;
  const rounded = roundMagnitude(quotient, twice, divisor, negative, mode);

  return negative ? -rounded : rounded;
}

function roundMagnitude(
  quotient: bigint,
  twiceRemainder: bigint,
  divisor: bigint,
  negative: boolean,
  mode: RoundingMode,
): bigint {
  switch (mode) {
    case RoundingMode.Up:
      return quotient + 1n;
    case RoundingMode.Down:
      return quotient;
    /* Ceiling and Floor are about the *signed* value, so the sign decides. */
    case RoundingMode.Ceiling:
      return negative ? quotient : quotient + 1n;
    case RoundingMode.Floor:
      return negative ? quotient + 1n : quotient;
    case RoundingMode.HalfUp:
      return twiceRemainder >= divisor ? quotient + 1n : quotient;
    case RoundingMode.HalfDown:
      return twiceRemainder > divisor ? quotient + 1n : quotient;
    case RoundingMode.HalfEven:
      if (twiceRemainder > divisor) return quotient + 1n;
      if (twiceRemainder < divisor) return quotient;
      return quotient % 2n === 0n ? quotient : quotient + 1n;
    default: {
      const exhaustive: never = mode;
      throw new Error(`Unsupported rounding mode: ${String(exhaustive)}`);
    }
  }
}
