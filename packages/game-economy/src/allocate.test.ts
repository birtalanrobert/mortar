import { describe, expect, it } from 'vitest';
import { allocate } from './allocate';
import { balanceOf } from './balance-of';
import { isRefundable } from './is-refundable';
import { isSpendOrder } from './spend-order';
import type { Lot } from './types';

const lot = (
  id: string,
  kind: Lot['kind'],
  remaining: number,
  seq: number,
  amount = remaining,
): Lot => ({
  id,
  kind,
  amount,
  remaining,
  seq,
});

describe('which credits a debit draws on', () => {
  const lots = [
    lot('bought-first', 'purchase', 100, 1),
    lot('granted', 'grant', 30, 2),
    lot('bought-later', 'purchase', 50, 3),
    lot('granted-later', 'grant', 20, 4),
  ];

  it('takes the kinds in the order given, the oldest first within a kind', () => {
    expect(allocate(lots, 60, ['grant', 'purchase'])).toEqual([
      { lotId: 'granted', amount: 30 },
      { lotId: 'granted-later', amount: 20 },
      { lotId: 'bought-first', amount: 10 },
    ]);
    expect(allocate(lots, 120, ['purchase', 'grant'])).toEqual([
      { lotId: 'bought-first', amount: 100 },
      { lotId: 'bought-later', amount: 20 },
    ]);
  });

  it('takes from no credit with nothing left', () => {
    expect(
      allocate([lot('spent', 'grant', 0, 1, 40), lot('whole', 'grant', 5, 2)], 5, [
        'grant',
        'purchase',
      ]),
    ).toEqual([{ lotId: 'whole', amount: 5 }]);
  });

  it('takes all of it or none: less left than asked is no draw at all', () => {
    expect(allocate(lots, 200, ['grant', 'purchase'])).toEqual([
      { lotId: 'granted', amount: 30 },
      { lotId: 'granted-later', amount: 20 },
      { lotId: 'bought-first', amount: 100 },
      { lotId: 'bought-later', amount: 50 },
    ]);
    expect(allocate(lots, 201, ['grant', 'purchase'])).toBeNull();
    expect(allocate([], 1, ['grant', 'purchase'])).toBeNull();
  });

  it('refuses a debit of nothing, of less, or of a part', () => {
    for (const amount of [0, -5, 1.5, Number.NaN]) {
      expect(() => allocate(lots, amount, ['grant', 'purchase'])).toThrow(RangeError);
    }
  });
});

describe('a ledger', () => {
  it('balances every credit in against every debit out', () => {
    expect(
      balanceOf([
        { kind: 'purchase', amount: 260 },
        { kind: 'grant', amount: 10 },
        { kind: 'spend', amount: 150 },
        { kind: 'refund', amount: 100 },
      ]),
    ).toBe(20);
    expect(balanceOf([])).toBe(0);
  });

  it('refunds only a purchase none of which is spent', () => {
    expect(isRefundable({ kind: 'purchase', amount: 260, remaining: 260 })).toBe(true);
    expect(isRefundable({ kind: 'purchase', amount: 260, remaining: 259 })).toBe(false);
    expect(isRefundable({ kind: 'purchase', amount: 260, remaining: 0 })).toBe(false);
    expect(isRefundable({ kind: 'grant', amount: 10, remaining: 10 })).toBe(false);
  });

  it('is spent in an order that names every kind of credit once', () => {
    expect(isSpendOrder(['grant', 'purchase'])).toBe(true);
    expect(isSpendOrder(['purchase', 'grant'])).toBe(true);
    expect(isSpendOrder(['grant'])).toBe(false);
    expect(isSpendOrder(['grant', 'grant'])).toBe(false);
    expect(isSpendOrder([])).toBe(false);
  });
});
