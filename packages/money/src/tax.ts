import { money, multiply, subtract, type Money } from './money';
import { DEFAULT_ROUNDING, RoundingMode, roundToInteger } from './rounding';

/**
 * A net (tax-exclusive) and gross (tax-inclusive) pair, with the tax itself.
 *
 * Both figures are always carried together and always labelled. Several of the
 * projects in this catalogue note the same failure: comparing a gross selling
 * price to a net cost overstates margin by the whole tax rate, and it is the
 * single most common error in the spreadsheets these systems replace.
 */
export interface TaxedAmount {
  readonly net: Money;
  readonly tax: Money;
  readonly gross: Money;
  /** The rate applied, in percent. */
  readonly rate: number;
}

function assertRate(rate: number): void {
  if (!Number.isFinite(rate) || rate < 0) {
    throw new Error(`Tax rate must be a finite non-negative percentage, received: ${rate}`);
  }
}

/** Builds a taxed amount from a net (tax-exclusive) figure. */
export function fromNet(
  net: Money,
  rate: number,
  mode: RoundingMode = DEFAULT_ROUNDING,
): TaxedAmount {
  assertRate(rate);
  const tax = multiply(net, rate / 100, mode);
  return {
    net,
    tax,
    gross: money(net.amount + tax.amount, net.currency),
    rate,
  };
}

/**
 * Builds a taxed amount from a gross (tax-inclusive) figure, extracting the
 * tax component.
 *
 * The tax is derived from the gross rather than recomputed from the net, so
 * net + tax always equals the gross exactly — which matters because the gross
 * is the number the customer actually paid and it must not move.
 */
export function fromGross(
  gross: Money,
  rate: number,
  mode: RoundingMode = DEFAULT_ROUNDING,
): TaxedAmount {
  assertRate(rate);
  const netAmount = roundToInteger(gross.amount / (1 + rate / 100), mode);
  const net = money(netAmount, gross.currency);
  return {
    net,
    tax: subtract(gross, net),
    gross,
    rate,
  };
}

/** Convenience: the gross figure for a net amount at a rate. */
export function addTax(net: Money, rate: number, mode?: RoundingMode): Money {
  return fromNet(net, rate, mode).gross;
}

/** Convenience: the net figure inside a gross amount at a rate. */
export function removeTax(gross: Money, rate: number, mode?: RoundingMode): Money {
  return fromGross(gross, rate, mode).net;
}
