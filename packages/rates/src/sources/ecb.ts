import { rate, type ExchangeRate } from '@birtalanrobert/money/rates';
import { asArray, parser } from './bnr';
import type { RateSource } from './port';

/**
 * The European Central Bank's daily reference rates.
 *
 * **The opposite direction from the BNR's**: the ECB quotes foreign currency
 * per one euro, so base is EUR and quote is the foreign currency. Both are
 * stored exactly as published and neither is inverted — which is why a table
 * holding both needs the publisher on every row, and why `settle` filters by
 * source before it looks anything up.
 *
 * The ninety-day feed rather than the daily one, for the same reason the BNR's
 * ten-day feed is used: overlap makes the job idempotent and lets a worker that
 * has been down catch up on its own.
 */
export const ECB: RateSource = {
  name: 'ECB',
  url: 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml',

  parse(document: string): ExchangeRate[] {
    const parsed = parser.parse(document) as EcbDocument;

    /*
     * Three nested `Cube` elements with the same name and different meanings:
     * an outer container, one per day, one per currency. The namespace prefix
     * is stripped by the parser, so what is left is this shape.
     */
    const outer = parsed?.Envelope?.Cube?.Cube;
    if (outer === undefined) throw new Error('ECB: no Cube in the document');

    const days = asArray(outer);
    if (days.length === 0) throw new Error('ECB: no days in the document');

    return days.flatMap((day) => {
      const asOf = day['@_time'];
      if (typeof asOf !== 'string') throw new Error('ECB: a day with no time attribute');

      return asArray(day.Cube).flatMap((one) => {
        const quote = one['@_currency'];
        const value = one['@_rate'];

        if (value === undefined || value === '') return [];
        if (typeof quote !== 'string') throw new Error('ECB: a rate with no currency');

        return [rate('EUR', quote, String(value), { asOf, source: 'ECB' })];
      });
    });
  },
};

interface EcbDocument {
  Envelope?: { Cube?: { Cube?: EcbDay | EcbDay[] } };
}

interface EcbDay {
  '@_time'?: string;
  Cube?: { '@_currency'?: string; '@_rate'?: string | number }[];
}
