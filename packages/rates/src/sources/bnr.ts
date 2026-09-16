import { XMLParser } from 'fast-xml-parser';
import { rate, type ExchangeRate } from '@birtalanrobert/money/rates';
import { shiftDecimal } from './decimal';
import type { RateSource } from './port';

/**
 * The National Bank of Romania's reference rates.
 *
 * **Quoted as lei per one unit of the foreign currency**, which is the
 * direction a Romanian lease needs and therefore the direction these are
 * stored: base EUR, quote RON. Nothing is inverted anywhere.
 *
 * `multiplier` is the part that is easy to miss. The forint is published per
 * hundred — `<Rate currency="HUF" multiplier="100">1.2600</Rate>` means 0.0126
 * lei to the forint, not 1.26 — and a parser ignoring the attribute is out by
 * two orders of magnitude on exactly the currencies this product needs most.
 *
 * `nbrfxrates10days.xml` rather than the single-day feed: ten days of overlap
 * makes the job idempotent and lets a worker that was down over a long weekend
 * catch up without anybody noticing.
 */
export const BNR: RateSource = {
  name: 'BNR',
  url: 'https://www.bnr.ro/nbrfxrates10days.xml',

  parse(document: string): ExchangeRate[] {
    const parsed = parser.parse(document) as BnrDocument;
    const body = parsed?.DataSet?.Body;

    if (!body) throw new Error('BNR: no Body in the document');

    const quote = body.OrigCurrency;
    if (typeof quote !== 'string' || quote.length !== 3) {
      throw new Error(`BNR: no OrigCurrency, or not a currency code: ${String(quote)}`);
    }

    const days = asArray(body.Cube);
    if (days.length === 0) throw new Error('BNR: no Cube in the document');

    return days.flatMap((day) => {
      const asOf = day['@_date'];
      if (typeof asOf !== 'string') throw new Error('BNR: a Cube with no date');

      return asArray(day.Rate).flatMap((one) => {
        const base = one['@_currency'];
        const value = one['#text'];

        /*
         * A rate with no value is normal and is not an error: the feed carries
         * `<Rate currency="XDR"/>` on days a currency was not quoted.
         */
        if (value === undefined || value === '') return [];
        if (typeof base !== 'string') throw new Error('BNR: a Rate with no currency');

        const multiplier = Number(one['@_multiplier'] ?? 1);
        if (!Number.isInteger(multiplier) || multiplier < 1) {
          throw new Error(`BNR: a multiplier that is not a whole number: ${String(multiplier)}`);
        }

        return [
          rate(base, quote, shiftDecimal(String(value), Math.log10(multiplier)), {
            asOf,
            source: 'BNR',
          }),
        ];
      });
    });
  },
};

interface BnrRate {
  '@_currency'?: string;
  '@_multiplier'?: string | number;
  '#text'?: string | number;
}

interface BnrDocument {
  DataSet?: { Body?: { OrigCurrency?: string; Cube?: BnrCube | BnrCube[] } };
}

interface BnrCube {
  '@_date'?: string;
  Rate?: BnrRate | BnrRate[];
}

/**
 * Shared by all three fetchers, and configured the same way for a reason.
 *
 * `parseAttributeValue: false` above all: the parser would otherwise turn
 * `rate="4.9772"` into a JavaScript number, which is the single thing this
 * whole module exists to avoid. Every value stays a string until
 * `@birtalanrobert/money/rates` parses it exactly.
 */
export const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  /* The ECB's document is namespaced; the BNR's is not. Stripping both means
   * one shape to read rather than two. */
  removeNSPrefix: true,
});

/** One or many, because an XML parser cannot tell which a single child is. */
export function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
