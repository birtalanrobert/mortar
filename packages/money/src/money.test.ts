import { describe, expect, it } from 'vitest';
import {
  CurrencyMismatchError,
  InvalidAmountError,
  UnknownCurrencyError,
  abs,
  add,
  compare,
  divide,
  equals,
  fromJSON,
  fromMajor,
  greaterThan,
  isMoney,
  isNegative,
  isPositive,
  isZero,
  lessThan,
  max,
  min,
  money,
  multiply,
  negate,
  percentage,
  registerCurrency,
  subtract,
  sum,
  toJSON,
  toMajor,
  zero,
} from './index';

describe('construction', () => {
  it('builds from minor units', () => {
    const m = money(1234, 'EUR');
    expect(m.amount).toBe(1234);
    expect(m.currency).toBe('EUR');
  });

  it('normalises the currency code to uppercase', () => {
    expect(money(1, 'eur').currency).toBe('EUR');
  });

  it('is frozen, so Money is never mutated in place', () => {
    expect(Object.isFrozen(money(1, 'EUR'))).toBe(true);
  });

  it('rejects non-integer minor units', () => {
    expect(() => money(1.5, 'EUR')).toThrow(InvalidAmountError);
  });

  it('rejects unsafe integers rather than silently losing precision', () => {
    expect(() => money(Number.MAX_SAFE_INTEGER + 2, 'EUR')).toThrow(InvalidAmountError);
  });

  it('rejects unknown currencies', () => {
    expect(() => money(1, 'XYZ')).toThrow(UnknownCurrencyError);
  });
});

describe('fromMajor / toMajor', () => {
  it('converts decimals to minor units', () => {
    expect(fromMajor(12.34, 'EUR').amount).toBe(1234);
  });

  it('handles the float representation of 0.1 + 0.2 correctly', () => {
    expect(fromMajor(0.1 + 0.2, 'EUR').amount).toBe(30);
  });

  it('rounds to the currency precision', () => {
    expect(fromMajor(12.345, 'EUR').amount).toBe(1235);
  });

  it('honours a zero-exponent currency', () => {
    expect(fromMajor(1234, 'JPY').amount).toBe(1234);
  });

  it('round-trips through toMajor', () => {
    expect(toMajor(fromMajor(99.99, 'RON'))).toBeCloseTo(99.99, 10);
  });

  it('supports an application overriding an exponent at boot', () => {
    registerCurrency({ code: 'TST', exponent: 0, name: 'Test unit' });
    expect(fromMajor(1500, 'TST').amount).toBe(1500);
  });
});

describe('arithmetic', () => {
  const ten = money(1000, 'EUR');
  const three = money(300, 'EUR');

  it('adds and subtracts', () => {
    expect(add(ten, three).amount).toBe(1300);
    expect(subtract(ten, three).amount).toBe(700);
  });

  it('refuses to mix currencies', () => {
    expect(() => add(ten, money(300, 'RON'))).toThrow(CurrencyMismatchError);
    expect(() => compare(ten, money(300, 'RON'))).toThrow(CurrencyMismatchError);
  });

  it('negates and takes absolute value', () => {
    expect(negate(ten).amount).toBe(-1000);
    expect(abs(money(-1000, 'EUR')).amount).toBe(1000);
  });

  it('multiplies with rounding', () => {
    expect(multiply(money(1000, 'EUR'), 1.5).amount).toBe(1500);
    expect(multiply(money(333, 'EUR'), 0.5).amount).toBe(167); // HalfUp on .5
  });

  it('divides with rounding', () => {
    expect(divide(money(1000, 'EUR'), 3).amount).toBe(333);
  });

  it('rejects division by zero', () => {
    expect(() => divide(ten, 0)).toThrow(InvalidAmountError);
  });

  it('applies percentages the way contracts express them', () => {
    expect(percentage(money(10000, 'EUR'), 19).amount).toBe(1900);
    expect(percentage(money(10000, 'EUR'), 2.5).amount).toBe(250);
  });
});

describe('comparison', () => {
  const a = money(100, 'EUR');
  const b = money(200, 'EUR');

  it('compares', () => {
    expect(compare(a, b)).toBe(-1);
    expect(compare(b, a)).toBe(1);
    expect(compare(a, money(100, 'EUR'))).toBe(0);
    expect(lessThan(a, b)).toBe(true);
    expect(greaterThan(b, a)).toBe(true);
  });

  it('equals is currency-aware and does not throw', () => {
    expect(equals(a, money(100, 'EUR'))).toBe(true);
    expect(equals(a, money(100, 'RON'))).toBe(false);
  });

  it('reports sign', () => {
    expect(isZero(zero('EUR'))).toBe(true);
    expect(isPositive(a)).toBe(true);
    expect(isNegative(negate(a))).toBe(true);
  });

  it('finds min and max', () => {
    expect(min(b, a).amount).toBe(100);
    expect(max(b, a).amount).toBe(200);
  });
});

describe('sum', () => {
  it('sums a list', () => {
    expect(sum([money(100, 'EUR'), money(250, 'EUR')]).amount).toBe(350);
  });

  it('requires an explicit currency for an empty list', () => {
    expect(() => sum([])).toThrow();
    expect(sum([], 'EUR').amount).toBe(0);
  });
});

describe('serialisation', () => {
  it('round-trips through JSON', () => {
    const m = money(-1234, 'RON');
    expect(fromJSON(JSON.parse(JSON.stringify(toJSON(m))))).toEqual(m);
  });

  it('guards untyped values', () => {
    expect(isMoney({ amount: 1, currency: 'EUR' })).toBe(true);
    expect(isMoney({ amount: '1', currency: 'EUR' })).toBe(false);
    expect(isMoney(null)).toBe(false);
  });
});
