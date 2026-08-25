import { getCurrency, minorUnitsPerMajor, type CurrencyCode } from './currency';
import { ParseError } from './errors';
import { fromMajor, toMajor, type Money } from './money';
import type { RoundingMode } from './rounding';

export interface FormatOptions {
  /** BCP 47 locale, e.g. 'ro-RO', 'hu-HU', 'en-GB'. Defaults to 'en-GB'. */
  locale?: string;
  /** Render the currency symbol or code. Defaults to true. */
  showCurrency?: boolean;
  /** 'symbol' (€), 'code' (EUR) or 'name' (euros). Defaults to 'symbol'. */
  currencyDisplay?: 'symbol' | 'code' | 'name';
  /** Omit decimals when the amount is a whole major unit. */
  trimZeroDecimals?: boolean;
}

/**
 * Formats Money for display using Intl, honouring the currency's own exponent.
 *
 * Display only. Never parse the output of this function back into an amount:
 * locale formatting is not reversible in general, and `parse()` exists for
 * the cases where user input has to be read.
 */
export function format(m: Money, options: FormatOptions = {}): string {
  const {
    locale = 'en-GB',
    showCurrency = true,
    currencyDisplay = 'symbol',
    trimZeroDecimals = false,
  } = options;

  const definition = getCurrency(m.currency);
  const value = toMajor(m);
  const isWhole = m.amount % minorUnitsPerMajor(m.currency) === 0;
  const digits = trimZeroDecimals && isWhole ? 0 : definition.exponent;

  const formatter = new Intl.NumberFormat(locale, {
    style: showCurrency ? 'currency' : 'decimal',
    currency: showCurrency ? definition.code : undefined,
    currencyDisplay: showCurrency ? currencyDisplay : undefined,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

  return formatter.format(value);
}

/**
 * Parses a user-entered amount into Money.
 *
 * Handles both decimal conventions found in the target markets — "1.234,56"
 * and "1,234.56" — plus spaces, non-breaking spaces and a leading or trailing
 * currency symbol. The separator is decided by which of `.` or `,` appears
 * last, which is the only heuristic that reads both conventions correctly.
 */
export function parse(input: string, currency: CurrencyCode, mode?: RoundingMode): Money {
  if (typeof input !== 'string') throw new ParseError(String(input));

  // Strip everything that cannot form part of a number.
  let cleaned = input
    .replace(/[\s\u00A0\u202F\u2007\u2060]/g, '')
    .replace(/[^0-9.,\-+]/g, '')
    .trim();

  if (cleaned === '' || !/[0-9]/.test(cleaned)) throw new ParseError(input);

  const negative = cleaned.startsWith('-') || /\(.*\)/.test(input);
  cleaned = cleaned.replace(/[-+]/g, '');

  const lastDot = cleaned.lastIndexOf('.');
  const lastComma = cleaned.lastIndexOf(',');

  let normalized: string;
  if (lastDot === -1 && lastComma === -1) {
    normalized = cleaned;
  } else {
    const decimalIndex = Math.max(lastDot, lastComma);
    const integerPart = cleaned.slice(0, decimalIndex).replace(/[.,]/g, '');
    const fractionPart = cleaned.slice(decimalIndex + 1).replace(/[.,]/g, '');
    // A trailing group of exactly three digits with no other separator is a
    // thousands group ("1,234"), not a fraction.
    const onlyOneSeparator = (cleaned.match(/[.,]/g) ?? []).length === 1;
    normalized =
      onlyOneSeparator && fractionPart.length === 3
        ? `${integerPart}${fractionPart}`
        : `${integerPart}.${fractionPart}`;
  }

  const value = Number(normalized);
  if (!Number.isFinite(value)) throw new ParseError(input);

  return fromMajor(negative ? -value : value, currency, mode);
}
