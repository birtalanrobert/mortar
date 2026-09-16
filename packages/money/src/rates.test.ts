import { describe, expect, it } from 'vitest';
import { InvalidRateError, RateDirectionError, money, fromMajor, toMajor } from './index';
import { RATE_SCALE, conversionFactor, convert, invert, rate, rateOn, rateToString } from './rates';
import { RoundingMode } from './rounding';

/**
 * The BNR's reference rate on an ordinary Tuesday, and the figure every other
 * example here is measured against.
 */
const EUR_RON = rate('EUR', 'RON', '4.9772', { asOf: '2026-09-15', source: 'BNR' });

describe('building a rate', () => {
  it('holds a published rate exactly', () => {
    expect(EUR_RON.rate).toBe(49_772_000_000);
    expect(rateToString(EUR_RON)).toBe('4.9772');
  });

  /**
   * The reason a rate is parsed from text rather than read off a float.
   *
   * `Number('1.005')` is 1.00499999999999989, so multiplying it by 10^10 gives
   * 10_049_999_999 — one unit short of the rate that was actually published.
   * Nothing downstream can tell the difference, and nothing downstream should
   * have to.
   */
  it('does not go through a float on the way in', () => {
    expect(rate('EUR', 'RON', '1.005').rate).toBe(10_050_000_000);
  });

  it('accepts a whole number, and prints it back as one', () => {
    expect(rateToString(rate('EUR', 'EUR', '1'))).toBe('1');
  });

  it('refuses more precision than it can hold, rather than dropping digits', () => {
    expect(() => rate('EUR', 'RON', '4.977212345678')).toThrow(InvalidRateError);
  });

  it('refuses zero, a negative, and nonsense', () => {
    expect(() => rate('EUR', 'RON', '0')).toThrow(InvalidRateError);
    expect(() => rate('EUR', 'RON', '-4.9772')).toThrow(InvalidRateError);
    expect(() => rate('EUR', 'RON', '4,9772')).toThrow(InvalidRateError);
  });

  it('refuses exponential notation by name, rather than as a parse failure', () => {
    expect(() => rate('EUR', 'RON', 1e-7)).toThrow(/exponential/);
  });

  it('refuses an asOf that is an instant rather than a day', () => {
    expect(() => rate('EUR', 'RON', '4.9772', { asOf: '2026-09-15T10:00:00Z' })).toThrow(
      InvalidRateError,
    );
  });
});

describe('converting', () => {
  it('prices a lease in the currency it is settled in', () => {
    /* 450 EUR of rent, at the BNR's Tuesday rate. */
    const rent = fromMajor(450, 'EUR');

    expect(toMajor(convert(rent, EUR_RON))).toBeCloseTo(2239.74, 2);
    expect(convert(rent, EUR_RON)).toEqual(money(223_974, 'RON'));
  });

  /**
   * The direction guard, which is the reason this module exists at all.
   *
   * Applying a EUR/RON rate to lei gives 2239.74 *euros* — a number that is
   * plausible on a screen, wrong by a factor of twenty-five, and invisible in
   * any test that does not think to check.
   */
  it('refuses a rate applied the wrong way round', () => {
    expect(() => convert(fromMajor(2239.74, 'RON'), EUR_RON)).toThrow(RateDirectionError);
  });

  it('names both currencies in the refusal, and points at invert', () => {
    const failure = (() => {
      try {
        convert(fromMajor(100, 'RON'), EUR_RON);
        return undefined;
      } catch (error) {
        return error as Error;
      }
    })();

    expect(failure?.message).toContain('RON');
    expect(failure?.message).toContain('invert()');
  });

  /**
   * The bug the minor-unit ratio exists to prevent.
   *
   * Yen has no minor unit. 100 EUR at 170 JPY per EUR is ¥17,000, which in
   * minor units is 17000 — while the naive `minor × rate` gives 1,700,000,
   * a hundred times too much, with nothing in the types to notice.
   */
  it('crosses currencies with different minor units', () => {
    const converted = convert(fromMajor(100, 'EUR'), rate('EUR', 'JPY', '170'));

    expect(converted).toEqual(money(17_000, 'JPY'));
    expect(toMajor(converted)).toBe(17_000);
  });

  it('crosses back the other way', () => {
    const converted = convert(fromMajor(17_000, 'JPY'), rate('JPY', 'EUR', '0.00588'));

    /* 17000 × 0.00588 = 99.96 EUR, to the cent. */
    expect(converted).toEqual(money(9_996, 'EUR'));
  });

  /**
   * A million euros, which is where a `number` would stop being exact.
   *
   * 100_000_000 minor units × 49_772_000_000 is about 5 × 10^18 — five hundred
   * times `Number.MAX_SAFE_INTEGER`. Done in floating point the answer is not
   * merely rounded, it is rounded to whichever multiple of 1024 happens to be
   * nearest.
   */
  it('stays exact at amounts that overflow a safe integer mid-calculation', () => {
    expect(convert(fromMajor(1_000_000, 'EUR'), EUR_RON)).toEqual(money(497_720_000, 'RON'));
  });

  it('rounds once, at the end, under the mode it is given', () => {
    /* 1 EUR at 1.005 is 1.005 RON: a tie at the half-bani. */
    const tie = rate('EUR', 'RON', '1.005');

    expect(convert(fromMajor(1, 'EUR'), tie, RoundingMode.HalfUp).amount).toBe(101);
    expect(convert(fromMajor(1, 'EUR'), tie, RoundingMode.HalfDown).amount).toBe(100);
    expect(convert(fromMajor(1, 'EUR'), tie, RoundingMode.HalfEven).amount).toBe(100);
    expect(convert(fromMajor(1, 'EUR'), tie, RoundingMode.Down).amount).toBe(100);
    expect(convert(fromMajor(1, 'EUR'), tie, RoundingMode.Up).amount).toBe(101);
  });

  it('rounds a negative amount by the sign, not by the magnitude', () => {
    const tie = rate('EUR', 'RON', '1.005');
    const refund = money(-100, 'EUR');

    /* Ceiling is toward positive infinity, so a negative rounds toward zero. */
    expect(convert(refund, tie, RoundingMode.Ceiling).amount).toBe(-100);
    expect(convert(refund, tie, RoundingMode.Floor).amount).toBe(-101);
    expect(convert(refund, tie, RoundingMode.Up).amount).toBe(-101);
    expect(convert(refund, tie, RoundingMode.Down).amount).toBe(-100);
  });

  it('converts zero to zero, in the other currency', () => {
    expect(convert(money(0, 'EUR'), EUR_RON)).toEqual(money(0, 'RON'));
  });
});

describe('inverting', () => {
  it('turns a EUR/RON rate into a RON/EUR one', () => {
    const inverted = invert(EUR_RON);

    expect(inverted.base).toBe('RON');
    expect(inverted.quote).toBe('EUR');
    expect(rateToString(inverted)).toBe('0.2009161778');
  });

  /**
   * The loss, demonstrated where it is actually visible.
   *
   * Inverting twice does **not** give back the rate you started with —
   * 4.9772 becomes 0.2009161778 becomes 4.9771999993 — because ten decimal
   * places is where the reciprocal is cut off. That is the whole argument for
   * storing the published direction and converting once.
   *
   * It is worth being precise about the size of this, because overstating it
   * would be its own kind of wrong: at ten decimal places a converted amount
   * survives the return trip intact for every sum any of these products will
   * ever hold. The asserted figure below is the honest one, and the reason to
   * make inversion explicit is the direction bug rather than the arithmetic.
   */
  it('does not survive being inverted twice', () => {
    expect(rateToString(invert(invert(EUR_RON)))).toBe('4.9771999993');
  });

  it('nonetheless round-trips an ordinary amount to the cent', () => {
    const there = convert(fromMajor(450, 'EUR'), EUR_RON);

    expect(convert(there, invert(EUR_RON)).amount).toBe(45_000);
  });

  it('keeps the day and the source, because they still apply', () => {
    expect(invert(EUR_RON).asOf).toBe('2026-09-15');
    expect(invert(EUR_RON).source).toBe('BNR');
  });
});

describe('the conversion factor, for callers with their own decimal type', () => {
  it('is the same arithmetic convert does, exposed as a rational', () => {
    const { numerator, denominator } = conversionFactor(EUR_RON);

    /* 45000 minor EUR × factor = 223_974 minor RON, exactly as convert gives. */
    expect((45_000 * numerator) / denominator).toBe(223_974);
    expect(convert(fromMajor(450, 'EUR'), EUR_RON).amount).toBe(223_974);
  });

  it('carries the minor-unit ratio, which is the whole reason it exists', () => {
    /* EUR has two decimal places, JPY none: the ratio is 1/100. */
    const { numerator, denominator } = conversionFactor(rate('EUR', 'JPY', '170'));

    expect(numerator / denominator).toBeCloseTo(1.7, 10);
  });

  it('stays within the range a number holds exactly', () => {
    const { numerator, denominator } = conversionFactor(EUR_RON);

    expect(Number.isSafeInteger(numerator)).toBe(true);
    expect(Number.isSafeInteger(denominator)).toBe(true);
  });
});

describe('the rate that applied on a day', () => {
  const published = [
    rate('EUR', 'RON', '4.9750', { asOf: '2026-09-11' }),
    rate('EUR', 'RON', '4.9772', { asOf: '2026-09-15' }),
    rate('EUR', 'RON', '4.9801', { asOf: '2026-09-16' }),
    rate('EUR', 'HUF', '392.10', { asOf: '2026-09-15' }),
  ];

  it('takes the day’s own rate when there is one', () => {
    expect(rateOn(published, { base: 'EUR', quote: 'RON' }, '2026-09-15')?.asOf).toBe('2026-09-15');
  });

  /**
   * The case the convention exists for.
   *
   * Rent falls due on the first; the BNR does not publish on a Sunday. An exact
   * match would find nothing four times a year, and more often than that around
   * public holidays.
   */
  it('reaches back to the last working day when the bank did not publish', () => {
    /* The 13th is a Sunday; the last rate before it is Friday the 11th. */
    expect(rateOn(published, { base: 'EUR', quote: 'RON' }, '2026-09-13')?.asOf).toBe('2026-09-11');
  });

  /**
   * Never forward, which is the half that matters for a settled amount.
   *
   * A lookup taking the nearest in either direction would answer a question
   * about the 13th with Tuesday's rate as soon as Tuesday arrived — so the same
   * report run twice would produce two different figures.
   */
  it('never reaches forward, however close the later rate is', () => {
    expect(rateOn(published, { base: 'EUR', quote: 'RON' }, '2026-09-10')).toBeUndefined();
  });

  it('keeps the pairs apart', () => {
    expect(rateToString(rateOn(published, { base: 'EUR', quote: 'HUF' }, '2026-09-16')!)).toBe(
      '392.1',
    );
  });

  it('ignores a rate that does not say when it applied', () => {
    const undated = [rate('EUR', 'RON', '9.9999')];

    expect(rateOn(undated, { base: 'EUR', quote: 'RON' }, '2026-09-15')).toBeUndefined();
  });

  it('refuses a lookup by instant, which would be a timezone waiting to happen', () => {
    expect(() => rateOn(published, { base: 'EUR', quote: 'RON' }, '2026-09-15T00:00:00Z')).toThrow(
      InvalidRateError,
    );
  });
});

describe('the scale', () => {
  it('is what the documentation and the database column both say', () => {
    expect(RATE_SCALE).toBe(10);
  });
});
