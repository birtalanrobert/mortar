import { describe, expect, it } from 'vitest';
import {
  canConvert,
  convert,
  decimal,
  fromBase,
  isMoreThanZero,
  isUsableQuantity,
  quantity,
  toBase,
  unitTable,
  UnitTableError,
} from './index';

/**
 * The pack structure from project 04's worked example, which is the shape this
 * package was designed against: a bottle, a tray of six, a case of four trays,
 * and a pallet of forty cases.
 */
const beer = unitTable(
  [
    { code: 'tray', of: 'bottle', times: 6 },
    { code: 'case', of: 'tray', times: 4 },
    { code: 'pallet', of: 'case', times: 40 },
  ],
  { base: 'bottle' },
);

describe('a table of units', () => {
  it('resolves a chain to an absolute factor at definition time', () => {
    expect(beer.factor('bottle')?.toString()).toBe('1');
    expect(beer.factor('tray')?.toString()).toBe('6');
    expect(beer.factor('case')?.toString()).toBe('24');
    /* Forty cases of twenty-four, and nobody in a warehouse has to know that. */
    expect(beer.factor('pallet')?.toString()).toBe('960');
  });

  it('implies the base unit rather than making somebody declare it', () => {
    expect(beer.has('bottle')).toBe(true);
    expect(beer.codes).toEqual(['bottle', 'tray', 'case', 'pallet']);
  });

  it('takes an absolute factor where that is how somebody thinks', () => {
    /* Mass, the way project 03 holds it: everything against one base. */
    const mass = unitTable(
      [
        { code: 'kg', toBase: 1000 },
        { code: 'dag', toBase: 10 },
        { code: 't', toBase: 1_000_000 },
      ],
      { base: 'g' },
    );

    expect(mass.factor('dag')?.toString()).toBe('10');
    expect(mass.factor('t')?.toString()).toBe('1000000');
  });

  it('refuses a cycle, naming the loop', () => {
    /*
     * The whole reason the table resolves at definition time. A cycle caught at
     * *use* is a stack overflow inside an order total at two in the morning.
     */
    expect(() =>
      unitTable(
        [
          { code: 'case', of: 'tray', times: 4 },
          { code: 'tray', of: 'case', times: 0.25 },
        ],
        { base: 'bottle' },
      ),
    ).toThrow(/defined in terms of itself: case → tray → case/);
  });

  it('refuses a parent that is not in the table', () => {
    expect(() => unitTable([{ code: 'case', of: 'crate', times: 4 }], { base: 'bottle' })).toThrow(
      /"case" is defined in terms of "crate", which is not in this table/,
    );
  });

  it('refuses the same unit twice', () => {
    expect(() =>
      unitTable(
        [
          { code: 'case', toBase: 24 },
          { code: 'case', toBase: 12 },
        ],
        { base: 'bottle' },
      ),
    ).toThrow(/defined twice/);
  });

  it('refuses a unit worth nothing, because dividing by it is silent', () => {
    /*
     * Zero surfaces as Infinity in a total the first time somebody converts
     * *out* of the base, which nobody can trace back to a definition.
     */
    expect(() => unitTable([{ code: 'ghost', toBase: 0 }], { base: 'bottle' })).toThrow(
      /is not an amount of anything/,
    );
    expect(() => unitTable([{ code: 'debt', toBase: -2 }], { base: 'bottle' })).toThrow(
      /is not an amount of anything/,
    );
  });

  it('refuses a definition that says nothing at all', () => {
    expect(() => unitTable([{ code: 'vague' }], { base: 'bottle' })).toThrow(
      /says neither how many bottle it is nor what it is made of/,
    );
  });

  it('refuses a base unit declared as anything but one of itself', () => {
    expect(() => unitTable([{ code: 'bottle', toBase: 2 }], { base: 'bottle' })).toThrow(
      /is the base unit, so it is worth exactly 1 of itself/,
    );
  });

  it('carries the reason as data, not only as a message', () => {
    /*
     * Both consumers need this. One turns it into a prompt; the other into a
     * row problem with a line number in an import report, which cannot be done
     * by matching on a sentence.
     */
    try {
      unitTable([{ code: 'case', of: 'crate' }], { base: 'bottle' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(UnitTableError);
      expect((error as UnitTableError).problem).toMatchObject({
        reason: 'unknown-parent',
        unit: 'crate',
      });
    }
  });
});

describe('converting', () => {
  it('goes to the base unit', () => {
    const result = toBase(quantity(2, 'case'), beer);

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.amount.toString()).toBe('48');
    expect(result.ok && result.value.unit).toBe('bottle');
  });

  it('comes back from the base unit', () => {
    const result = fromBase(quantity(48, 'bottle'), 'case', beer);

    expect(result.ok && result.value.amount.toString()).toBe('2');
  });

  it('refuses to come back from something that is not the base', () => {
    /*
     * A caller holding trays and asking to see them in cases has made an
     * arithmetic error above; doing the right thing quietly would hide it.
     */
    const result = fromBase(quantity(4, 'tray'), 'case', beer);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.problem.reason).toBe('not-base');
  });

  it('converts between two units in one step, not along the chain', () => {
    /*
     * A pallet is 960 bottles and 40 cases. Walking pallet → case → tray →
     * bottle would round at each step; every factor is absolute, so this is one
     * multiplication and one division.
     */
    const result = convert(quantity(1, 'pallet'), 'tray', beer);

    expect(result.ok && result.value.amount.toString()).toBe('160');
  });

  it('is exact where floating point is not', () => {
    /*
     * 0.1 + 0.2 is the famous one; this is the version that reaches an invoice.
     * A third of a tray is not a thing anybody orders, but a factor of 3 in a
     * pack structure is, and the error compounds through the chain.
     */
    const thirds = unitTable([{ code: 'third', of: 'unit', times: '0.3333333333' }], {
      base: 'unit',
    });

    const result = convert(quantity(3, 'third'), 'unit', thirds);
    expect(result.ok && result.value.amount.toString()).toBe('0.9999999999');
  });

  it('returns the same quantity when the unit has not changed', () => {
    const value = quantity(7, 'case');
    const result = convert(value, 'case', beer);

    expect(result.ok && result.value).toBe(value);
  });

  it('names what it has never heard of, and lists what it has', () => {
    const result = convert(quantity(1, 'barrel'), 'bottle', beer);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.problem.says).toBe(
      '"barrel" is not one of the units this is counted in (bottle, tray, case, pallet).',
    );
  });

  it('says whether a conversion is possible before attempting it', () => {
    expect(canConvert(quantity(1, 'case'), 'bottle', beer)).toBe(true);
    expect(canConvert(quantity(1, 'case'), 'barrel', beer)).toBe(false);
  });
});

describe('the decimal rules every consumer shares', () => {
  it('rounds half up, like every spreadsheet a customer already uses', () => {
    expect(decimal('2.5').toDecimalPlaces(0).toString()).toBe('3');
    expect(decimal('3.5').toDecimalPlaces(0).toString()).toBe('4');
  });

  it('never writes a small number in exponential notation', () => {
    /* `1e-7` in a CSV export is a number a spreadsheet reads as text. */
    expect(decimal('0.0000001').toString()).toBe('0.0000001');
  });

  it('treats zero as a usable quantity and not as a positive one', () => {
    /*
     * `Decimal.isPositive()` is true for zero, which is defensible arithmetic
     * and not what any caller in this programme has ever meant.
     */
    expect(decimal(0).isPositive()).toBe(true);
    expect(isMoreThanZero(decimal(0))).toBe(false);
    expect(isUsableQuantity(decimal(0))).toBe(true);
  });

  it('refuses a negative quantity and an infinite one', () => {
    expect(isUsableQuantity(decimal(-1))).toBe(false);
    expect(isUsableQuantity(decimal(Infinity))).toBe(false);
    expect(isMoreThanZero(decimal(Infinity))).toBe(false);
  });

  it('keeps the unit with the number', () => {
    const value = quantity('2.5', 'kg');

    expect(value.unit).toBe('kg');
    expect(value.amount.toString()).toBe('2.5');
    expect(Object.isFrozen(value)).toBe(true);
  });
});
