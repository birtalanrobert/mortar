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
