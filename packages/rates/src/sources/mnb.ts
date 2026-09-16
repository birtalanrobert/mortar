import { rate, type ExchangeRate } from '@birtalanrobert/money/rates';
import { asArray, parser } from './bnr';
import { fromCommaDecimal, shiftDecimal } from './decimal';
import type { RateSource } from './port';

/**
 * The Hungarian National Bank's rates.
 *
 * Two things differ from the other two feeds and both are the sort of detail
 * that produces a plausible wrong number rather than a crash.
 *
 * **A comma decimal separator.** `392,10` is three hundred and ninety-two, and
 * `Number('392,10')` is `NaN` — which at least fails loudly — but a parser
 * stripping the comma instead reads thirty-nine thousand.
 *
 * **A `unit` attribute, like the BNR's multiplier.** The yen and the forint are
 * quoted per hundred. Same trap, different attribute name.
 *
 * Quoted as forints per `unit` of the foreign currency, so base is the foreign
 * currency and quote is HUF — the same direction as the BNR's and the opposite
 * of the ECB's.
 *
 * The URL is the SOAP endpoint's document rather than a REST feed because the
 * MNB publishes no other machine-readable form. `parse` takes the XML either
 * way, which is the point of keeping the network out of here.
 */
export const MNB: RateSource = {
  name: 'MNB',
  url: 'http://www.mnb.hu/arfolyamok.asmx',

  parse(document: string): ExchangeRate[] {
    const parsed = parser.parse(document) as MnbDocument;

    /*
     * Unwrapped from a SOAP envelope when it came from the web service, and
     * bare when it came from a file. Both shapes are accepted because the
     * difference is transport rather than content.
     */
    const rates =
      parsed?.MNBExchangeRates ??
      parsed?.Envelope?.Body?.GetExchangeRatesResponse?.GetExchangeRatesResult?.MNBExchangeRates;

    if (!rates) throw new Error('MNB: no MNBExchangeRates in the document');

    const days = asArray(rates.Day);
    if (days.length === 0) throw new Error('MNB: no days in the document');

    return days.flatMap((day) => {
      const asOf = day['@_date'];
      if (typeof asOf !== 'string') throw new Error('MNB: a day with no date');

      return asArray(day.Rate).flatMap((one) => {
        const base = one['@_curr'];
        const value = one['#text'];

        if (value === undefined || value === '') return [];
        if (typeof base !== 'string') throw new Error('MNB: a rate with no currency');

        const unit = Number(one['@_unit'] ?? 1);
        if (!Number.isInteger(unit) || unit < 1) {
          throw new Error(`MNB: a unit that is not a whole number: ${String(unit)}`);
        }

        return [
          rate(base, 'HUF', shiftDecimal(fromCommaDecimal(String(value)), Math.log10(unit)), {
            asOf,
            source: 'MNB',
          }),
        ];
      });
    });
  },
};

interface MnbRate {
  '@_curr'?: string;
  '@_unit'?: string | number;
  '#text'?: string | number;
}

interface MnbRates {
  Day?: MnbDay | MnbDay[];
}

interface MnbDay {
  '@_date'?: string;
  Rate?: MnbRate | MnbRate[];
}

interface MnbDocument {
  MNBExchangeRates?: MnbRates;
  Envelope?: {
    Body?: {
      GetExchangeRatesResponse?: {
        GetExchangeRatesResult?: { MNBExchangeRates?: MnbRates };
      };
    };
  };
}
