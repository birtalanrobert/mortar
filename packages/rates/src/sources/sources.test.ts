import { describe, expect, it } from 'vitest';
import { rateToString } from '@birtalanrobert/money/rates';
import { BNR } from './bnr';
import { ECB } from './ecb';
import { MNB } from './mnb';
import { fromCommaDecimal, shiftDecimal } from './decimal';

/**
 * Real document shapes, trimmed to the rows that matter.
 *
 * Recorded rather than fetched: the parsing is where every mistake in this
 * module will be, and a test that reached the network would prove that the
 * bank was up rather than that we read it correctly. The shapes are the
 * published ones — attribute names, namespaces, decimal separators and all.
 */

const BNR_XML = `<?xml version="1.0" encoding="utf-8"?>
<DataSet xmlns="http://www.bnr.ro/xsd">
  <Header><Publisher>National Bank of Romania</Publisher><PublishingDate>2026-09-15</PublishingDate></Header>
  <Body>
    <Subject>Reference rates</Subject>
    <OrigCurrency>RON</OrigCurrency>
    <Cube date="2026-09-14">
      <Rate currency="EUR">4.9768</Rate>
      <Rate currency="HUF" multiplier="100">1.2610</Rate>
    </Cube>
    <Cube date="2026-09-15">
      <Rate currency="EUR">4.9772</Rate>
      <Rate currency="USD">4.2531</Rate>
      <Rate currency="HUF" multiplier="100">1.2600</Rate>
      <Rate currency="XDR"/>
    </Cube>
  </Body>
</DataSet>`;

const ECB_XML = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <gesmes:subject>Reference rates</gesmes:subject>
  <Cube>
    <Cube time="2026-09-15">
      <Cube currency="USD" rate="1.1702"/>
      <Cube currency="RON" rate="4.9772"/>
      <Cube currency="HUF" rate="392.10"/>
    </Cube>
    <Cube time="2026-09-14">
      <Cube currency="RON" rate="4.9768"/>
    </Cube>
  </Cube>
</gesmes:Envelope>`;

const MNB_XML = `<?xml version="1.0" encoding="utf-8"?>
<MNBExchangeRates>
  <Day date="2026-09-15">
    <Rate unit="1" curr="EUR">392,10</Rate>
    <Rate unit="1" curr="RON">78,79</Rate>
    <Rate unit="100" curr="JPY">225,48</Rate>
  </Day>
</MNBExchangeRates>`;

describe('the National Bank of Romania', () => {
  const rates = BNR.parse(BNR_XML);

  it('reads lei per unit of the foreign currency, as published', () => {
    const eur = rates.find((one) => one.base === 'EUR' && one.asOf === '2026-09-15')!;

    expect(eur.quote).toBe('RON');
    expect(rateToString(eur)).toBe('4.9772');
    expect(eur.source).toBe('BNR');
  });

  /**
   * The attribute that is easy to miss and expensive to miss.
   *
   * `multiplier="100"` means 1.2600 lei per *hundred* forints. A parser
   * ignoring it is out by two orders of magnitude on exactly the currency pair
   * this product most needs — and the figure it produces, 1.26 lei to the
   * forint, is not obviously absurd to anybody who does not know the rate.
   */
  it('divides by the multiplier rather than taking the figure as published', () => {
    const huf = rates.find((one) => one.base === 'HUF' && one.asOf === '2026-09-15')!;

    expect(rateToString(huf)).toBe('0.0126');
  });

  it('reads every day the ten-day feed carries', () => {
    expect([...new Set(rates.map((one) => one.asOf))].sort()).toEqual(['2026-09-14', '2026-09-15']);
  });

  /* `<Rate currency="XDR"/>` is a normal day, not a broken document. */
  it('skips a currency that was not quoted, without complaining', () => {
    expect(rates.some((one) => one.base === 'XDR')).toBe(false);
    expect(rates).toHaveLength(5);
  });

  it('refuses a document it does not recognise, rather than returning nothing', () => {
    expect(() => BNR.parse('<html><body>Service unavailable</body></html>')).toThrow();
    expect(() => BNR.parse('<DataSet><Body><Subject>x</Subject></Body></DataSet>')).toThrow();
  });
});

describe('the European Central Bank', () => {
  const rates = ECB.parse(ECB_XML);

  /**
   * The opposite direction from the BNR's, which is why the publisher is on
   * every row and why settlement filters by it.
   */
  it('reads foreign currency per one euro', () => {
    const ron = rates.find((one) => one.quote === 'RON' && one.asOf === '2026-09-15')!;

    expect(ron.base).toBe('EUR');
    expect(rateToString(ron)).toBe('4.9772');
    expect(ron.source).toBe('ECB');
  });

  it('reads through the namespace prefixes', () => {
    expect(rates.filter((one) => one.asOf === '2026-09-15')).toHaveLength(3);
    expect(rates.filter((one) => one.asOf === '2026-09-14')).toHaveLength(1);
  });

  it('refuses a document it does not recognise', () => {
    expect(() => ECB.parse('<gesmes:Envelope/>')).toThrow();
  });
});

describe('the Hungarian National Bank', () => {
  const rates = MNB.parse(MNB_XML);

  /**
   * A comma decimal separator. `Number('392,10')` is NaN, which fails loudly —
   * but a parser that strips the comma instead reads thirty-nine thousand.
   */
  it('reads a comma as a decimal point', () => {
    const eur = rates.find((one) => one.base === 'EUR')!;

    expect(eur.quote).toBe('HUF');
    expect(rateToString(eur)).toBe('392.1');
  });

  it('divides by the unit, the way the BNR’s multiplier works', () => {
    const jpy = rates.find((one) => one.base === 'JPY')!;

    /* 225.48 forints per hundred yen is 2.2548 per yen. */
    expect(rateToString(jpy)).toBe('2.2548');
  });

  it('reads the same document inside a SOAP envelope', () => {
    const wrapped = `<?xml version="1.0"?>
      <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
        <soap:Body>
          <GetExchangeRatesResponse xmlns="http://www.mnb.hu/webservices/">
            <GetExchangeRatesResult>${MNB_XML.replace(/<\?xml[^?]*\?>/, '')}</GetExchangeRatesResult>
          </GetExchangeRatesResponse>
        </soap:Body>
      </soap:Envelope>`;

    expect(
      MNB.parse(wrapped)
        .map((one) => one.base)
        .sort(),
    ).toEqual(['EUR', 'JPY', 'RON']);
  });

  it('refuses a value carrying both separators rather than guessing', () => {
    expect(() => fromCommaDecimal('1.234,56')).toThrow(RangeError);
  });
});

/**
 * The decimal shift, on its own, because the alternative — dividing — is the
 * exact thing an integer rate representation exists to avoid. `1.26 / 100` in
 * floating point is 0.012600000000000002.
 */
describe('shifting a decimal point', () => {
  it('divides by a power of ten exactly', () => {
    expect(shiftDecimal('1.2600', 2)).toBe('0.0126');
    expect(shiftDecimal('225.48', 2)).toBe('2.2548');
    expect(shiftDecimal('4.9772', 0)).toBe('4.9772');
    expect(shiftDecimal('392,10'.replace(',', '.'), 0)).toBe('392.1');
  });

  it('pads when the point runs off the left', () => {
    expect(shiftDecimal('5', 3)).toBe('0.005');
    expect(shiftDecimal('1.5', 4)).toBe('0.00015');
  });

  it('multiplies when asked to move the other way', () => {
    expect(shiftDecimal('0.0126', -2)).toBe('1.26');
  });

  it('refuses something that is not a number', () => {
    expect(() => shiftDecimal('four point nine', 0)).toThrow(RangeError);
    expect(() => shiftDecimal('', 0)).toThrow(RangeError);
  });
});
