import { describe, expect, it } from 'vitest';
import { ParseError, format, money, parse } from './index';

describe('format', () => {
  it('formats with the currency symbol', () => {
    const out = format(money(123456, 'EUR'), { locale: 'en-GB' });
    expect(out).toContain('1,234.56');
  });

  it('honours a locale that uses comma decimals', () => {
    const out = format(money(123456, 'RON'), { locale: 'ro-RO' });
    expect(out.replace(/\s/g, '')).toContain('1.234,56');
  });

  it('can render the code instead of the symbol', () => {
    expect(format(money(100, 'EUR'), { currencyDisplay: 'code' })).toContain('EUR');
  });

  it('can omit the currency entirely', () => {
    const out = format(money(100, 'EUR'), { showCurrency: false });
    expect(out).toBe('1.00');
  });

  it('can trim zero decimals for whole amounts', () => {
    expect(format(money(500, 'EUR'), { showCurrency: false, trimZeroDecimals: true })).toBe('5');
    expect(format(money(550, 'EUR'), { showCurrency: false, trimZeroDecimals: true })).toBe('5.50');
  });

  it('respects a zero-exponent currency', () => {
    expect(format(money(1234, 'JPY'), { showCurrency: false })).toBe('1,234');
  });
});

describe('parse', () => {
  it('reads the Anglo convention', () => {
    expect(parse('1,234.56', 'EUR').amount).toBe(123456);
  });

  it('reads the Continental convention used in both target markets', () => {
    expect(parse('1.234,56', 'RON').amount).toBe(123456);
  });

  it('reads a plain decimal in either convention', () => {
    expect(parse('12.34', 'EUR').amount).toBe(1234);
    expect(parse('12,34', 'EUR').amount).toBe(1234);
  });

  it('treats a lone three-digit group as thousands, not a fraction', () => {
    expect(parse('1,234', 'EUR').amount).toBe(123400);
    expect(parse('1.234', 'EUR').amount).toBe(123400);
  });

  it('strips currency symbols and spacing', () => {
    expect(parse('€ 1 234,56', 'EUR').amount).toBe(123456);
    expect(parse('1 234,56 lei', 'RON').amount).toBe(123456);
  });

  it('handles negatives', () => {
    expect(parse('-12.34', 'EUR').amount).toBe(-1234);
  });

  it('handles a whole number', () => {
    expect(parse('42', 'EUR').amount).toBe(4200);
  });

  it('rejects input with no digits', () => {
    expect(() => parse('abc', 'EUR')).toThrow(ParseError);
    expect(() => parse('', 'EUR')).toThrow(ParseError);
  });
});
