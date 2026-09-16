/** Base class for every error this package raises. */
export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Raised when an operation combines two different currencies.
 *
 * This is always a programming error, never user input, and it is deliberately
 * fatal: silently coercing currencies is how money quietly goes missing.
 */
export class CurrencyMismatchError extends MoneyError {
  constructor(
    readonly left: string,
    readonly right: string,
  ) {
    super(`Cannot operate on different currencies: ${left} and ${right}`);
  }
}

/** Raised when an amount is not a safe integer number of minor units. */
export class InvalidAmountError extends MoneyError {
  constructor(readonly amount: unknown) {
    super(
      `Amount must be a safe integer number of minor units, received: ${String(amount)}. ` +
        `Use fromMajor() to build Money from a decimal value.`,
    );
  }
}

/** Raised when a currency code is unknown to the registry. */
export class UnknownCurrencyError extends MoneyError {
  constructor(readonly code: string) {
    super(`Unknown currency: ${code}. Register it with registerCurrency() before use.`);
  }
}

/** Raised when a string cannot be parsed into an amount. */
export class ParseError extends MoneyError {
  constructor(readonly input: string) {
    super(`Cannot parse "${input}" as a monetary amount`);
  }
}

/**
 * A rate that is not a rate: unparseable, zero, negative, or carrying more
 * precision than `RATE_SCALE` can hold.
 *
 * Precision is refused rather than rounded away, deliberately. A rate arriving
 * with twelve decimal places is a rate from somewhere that disagrees with us
 * about what a rate is, and quietly dropping the last two digits is how the
 * disagreement becomes a discrepancy nobody can trace.
 */
export class InvalidRateError extends MoneyError {
  constructor(
    readonly value: unknown,
    reason: string,
  ) {
    super(`Invalid exchange rate ${String(value)}: ${reason}`);
    this.name = 'InvalidRateError';
  }
}

/**
 * A rate applied in the direction it does not go.
 *
 * The single commonest bug in currency code, and the reason `convert` refuses
 * rather than inverting: a rate published as "1 EUR buys 4.9772 RON" applied to
 * RON gives an answer that is wrong by a factor of twenty-five and looks
 * entirely plausible on a screen. Inverting is available, spelled `invert`, and
 * says in its own documentation what it costs.
 */
export class RateDirectionError extends MoneyError {
  constructor(
    readonly from: string,
    readonly base: string,
    readonly quote: string,
  ) {
    super(
      `Cannot convert ${from} with a ${base}/${quote} rate: ` +
        `the rate prices one ${base} in ${quote}. Use invert() if that is what you mean.`,
    );
    this.name = 'RateDirectionError';
  }
}
