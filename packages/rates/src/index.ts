/**
 * Published exchange rates, from the central banks that publish them.
 *
 * The other half of `@birtalanrobert/money/rates`, and the line between them is
 * deliberate: that package is **arithmetic** — a rate's representation, its
 * direction, conversion, the on-or-before lookup — and this one is
 * **acquisition**. The split is what keeps a console that shows a converted
 * price from installing an XML parser and an ORM to do it.
 *
 * This root is framework-free and database-free: three parsers, each a pure
 * function from a published document to `ExchangeRate` values. Everything that
 * needs Nest or TypeORM — the table, the service that reads it, the fetcher
 * that fills it — is behind `@birtalanrobert/rates/nestjs`.
 *
 * **Why the parsers are separate from the fetching at all**: parsing is where
 * every mistake in this package will be, and it is only testable against
 * recorded payloads if the network is somewhere else. Two of the three feeds
 * carry an attribute that shifts a rate by two orders of magnitude — the BNR's
 * `multiplier` and the MNB's `unit` — and the wrong figure is not obviously
 * absurd to anybody who does not already know the rate.
 */

export { BNR } from './sources/bnr';
export { ECB } from './sources/ecb';
export { MNB } from './sources/mnb';
export { fromCommaDecimal, shiftDecimal } from './sources/decimal';
export type { RateSource, SourceResult } from './sources/port';
