import { describe, expect, it } from 'vitest';
import { addTax, fromGross, fromNet, money, removeTax } from './index';

describe('fromNet', () => {
  it('adds tax to a net figure', () => {
    const t = fromNet(money(10000, 'EUR'), 19);
    expect(t.net.amount).toBe(10000);
    expect(t.tax.amount).toBe(1900);
    expect(t.gross.amount).toBe(11900);
  });

  it('handles the Romanian and Hungarian standard rates', () => {
    expect(fromNet(money(10000, 'RON'), 21).gross.amount).toBe(12100);
    expect(fromNet(money(10000, 'HUF'), 27).gross.amount).toBe(12700);
  });

  it('handles a zero rate', () => {
    const t = fromNet(money(500, 'EUR'), 0);
    expect(t.tax.amount).toBe(0);
    expect(t.gross.amount).toBe(500);
  });

  it('rejects a negative rate', () => {
    expect(() => fromNet(money(100, 'EUR'), -1)).toThrow();
  });
});

describe('fromGross', () => {
  it('extracts tax from a gross figure', () => {
    const t = fromGross(money(11900, 'EUR'), 19);
    expect(t.net.amount).toBe(10000);
    expect(t.tax.amount).toBe(1900);
    expect(t.gross.amount).toBe(11900);
  });

  it('never moves the gross figure, because that is what was actually paid', () => {
    for (const rate of [5, 9, 19, 20, 21, 24, 27]) {
      for (let gross = 1; gross < 400; gross++) {
        const t = fromGross(money(gross, 'EUR'), rate);
        expect(t.gross.amount).toBe(gross);
        expect(t.net.amount + t.tax.amount).toBe(gross);
      }
    }
  });

  it('is the inverse of fromNet for representative values', () => {
    const net = money(8403, 'EUR');
    const gross = addTax(net, 19);
    expect(removeTax(gross, 19).amount).toBe(net.amount);
  });
});
