import type { ExchangeRate } from '@birtalanrobert/money/rates';

/**
 * One publisher's feed.
 *
 * A port rather than three classes with a fetch in each, for the ordinary
 * reason: the parsing is where every mistake in this module will be, and it is
 * only testable against recorded payloads if the network is somewhere else.
 * Every fetcher below is therefore a pure function from a string of XML to
 * rates, and `fetch` lives in one place.
 */
export interface RateSource {
  /** 'BNR', 'ECB', 'MNB' — recorded on every rate so a figure can be defended. */
  readonly name: string;

  /** Where the feed is. Configurable, so a deployment can point at a mirror. */
  readonly url: string;

  /**
   * Turns a published document into rates.
   *
   * Throws on a document it does not recognise. It must not return an empty
   * list for one — "the feed changed shape" and "the bank published nothing
   * today" are different facts, and only the first needs somebody woken up.
   */
  parse(document: string): ExchangeRate[];
}

/** What a fetch produced, kept separate so a failure can be reported per source. */
export interface SourceResult {
  readonly source: string;
  readonly rates: readonly ExchangeRate[];
  readonly error?: string;
}
