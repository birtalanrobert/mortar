import { UnknownCurrencyError } from './errors';

/** An ISO 4217 alpha-3 currency code. */
export type CurrencyCode = string;

export interface CurrencyDefinition {
  /** ISO 4217 alpha-3 code, uppercase. */
  readonly code: CurrencyCode;
  /**
   * Number of decimal places. The minor unit is `10 ** -exponent` of the major
   * unit: EUR has exponent 2 (cents), JPY has exponent 0 (no subunit).
   */
  readonly exponent: number;
  /** Human-readable name, for admin surfaces and error messages. */
  readonly name: string;
}

/**
 * Currencies registered by default.
 *
 * Exponents follow ISO 4217. Note that HUF is listed by ISO with exponent 2
 * even though Hungarian everyday practice uses whole forints — if a project
 * wants integer forints it should override the definition explicitly rather
 * than relying on a surprising default:
 *
 *   registerCurrency({ code: 'HUF', exponent: 0, name: 'Hungarian forint' });
 */
const DEFAULT_CURRENCIES: readonly CurrencyDefinition[] = [
  { code: 'EUR', exponent: 2, name: 'Euro' },
  { code: 'RON', exponent: 2, name: 'Romanian leu' },
  { code: 'HUF', exponent: 2, name: 'Hungarian forint' },
  { code: 'USD', exponent: 2, name: 'US dollar' },
  { code: 'GBP', exponent: 2, name: 'Pound sterling' },
  { code: 'CHF', exponent: 2, name: 'Swiss franc' },
  { code: 'PLN', exponent: 2, name: 'Polish złoty' },
  { code: 'CZK', exponent: 2, name: 'Czech koruna' },
  { code: 'BGN', exponent: 2, name: 'Bulgarian lev' },
  { code: 'RSD', exponent: 2, name: 'Serbian dinar' },
  { code: 'UAH', exponent: 2, name: 'Ukrainian hryvnia' },
  { code: 'MDL', exponent: 2, name: 'Moldovan leu' },
  { code: 'SEK', exponent: 2, name: 'Swedish krona' },
  { code: 'NOK', exponent: 2, name: 'Norwegian krone' },
  { code: 'DKK', exponent: 2, name: 'Danish krone' },
  { code: 'JPY', exponent: 0, name: 'Japanese yen' },
];

const registry = new Map<string, CurrencyDefinition>(DEFAULT_CURRENCIES.map((c) => [c.code, c]));

/**
 * Registers or replaces a currency definition.
 *
 * Call this at application boot, before any Money is constructed, so that the
 * exponent a project relies on is never ambiguous.
 */
export function registerCurrency(definition: CurrencyDefinition): void {
  const code = definition.code.toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new Error(`Currency code must be three letters, received: ${definition.code}`);
  }
  if (
    !Number.isInteger(definition.exponent) ||
    definition.exponent < 0 ||
    definition.exponent > 8
  ) {
    throw new Error(
      `Currency exponent must be an integer between 0 and 8, received: ${definition.exponent}`,
    );
  }
  registry.set(code, { ...definition, code });
}

/** Returns a currency definition, throwing if it is not registered. */
export function getCurrency(code: CurrencyCode): CurrencyDefinition {
  const definition = registry.get(code.toUpperCase());
  if (!definition) throw new UnknownCurrencyError(code);
  return definition;
}

/** Whether a currency code is known to the registry. */
export function isCurrencyRegistered(code: CurrencyCode): boolean {
  return registry.has(code.toUpperCase());
}

/** All registered currencies, for admin surfaces and validation. */
export function listCurrencies(): readonly CurrencyDefinition[] {
  return [...registry.values()];
}

/** The number of minor units in one major unit, e.g. 100 for EUR. */
export function minorUnitsPerMajor(code: CurrencyCode): number {
  return 10 ** getCurrency(code).exponent;
}
