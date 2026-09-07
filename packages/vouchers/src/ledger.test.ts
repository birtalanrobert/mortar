import { describe, expect, it } from 'vitest';

import {
  applicable,
  balanceOf,
  canRedeem,
  expiryFrom,
  signOf,
  type LedgerEntry,
  type Voucher,
} from './ledger';

const NOW = Date.UTC(2026, 5, 15, 12);

function voucher(over: Partial<Voucher> = {}): Voucher {
  return {
    denomination: 'money',
    balance: 20_000,
    expiresAt: null,
    cancelledAt: null,
    ...over,
  };
}

describe('the balance', () => {
  it('is the sum of what happened, not a number somebody wrote down', () => {
    const entries: LedgerEntry[] = [
      { kind: 'issued', amount: 20_000 },
      { kind: 'redeemed', amount: 5_000 },
      { kind: 'redeemed', amount: 5_000 },
    ];

    expect(balanceOf(entries)).toBe(10_000);
  });

  it('gives value back when a redemption is released', () => {
    // An appointment cancelled, or a mistake at the desk. A counter would have
    // to be edited; a ledger records that it happened and moves on.
    expect(
      balanceOf([
        { kind: 'issued', amount: 10 },
        { kind: 'redeemed', amount: 3 },
        { kind: 'released', amount: 3 },
      ]),
    ).toBe(10);
  });

  it('reads the direction from the kind, never from the sign', () => {
    /*
     * A negative amount on a `redeemed` row reads as a refund to one query and
     * as a double redemption to another, and both are plausible. There is one
     * place the direction is decided.
     */
    expect(balanceOf([{ kind: 'redeemed', amount: -400 }])).toBe(-400);
    expect(signOf('expired')).toBe(-1);
    expect(signOf('adjusted')).toBe(1);
  });

  it('is empty for a voucher nothing has happened to', () => {
    expect(balanceOf([])).toBe(0);
  });
});

describe('redeeming', () => {
  it('allows what the balance covers', () => {
    expect(canRedeem(voucher(), { amount: 20_000 }, NOW)).toEqual({ ok: true });
  });

  it('refuses more than is left, and says so', () => {
    expect(canRedeem(voucher(), { amount: 20_001 }, NOW)).toEqual({
      ok: false,
      why: 'not-enough',
    });
  });

  it('refuses a cancelled voucher before it looks at anything else', () => {
    expect(canRedeem(voucher({ cancelledAt: NOW - 1 }), { amount: 1 }, NOW)).toEqual({
      ok: false,
      why: 'cancelled',
    });
  });

  it('refuses one that has expired, to the second', () => {
    expect(canRedeem(voucher({ expiresAt: NOW }), { amount: 1 }, NOW)).toEqual({
      ok: false,
      why: 'expired',
    });

    expect(canRedeem(voucher({ expiresAt: NOW + 1 }), { amount: 1 }, NOW)).toEqual({ ok: true });
  });

  it('refuses nonsense amounts', () => {
    for (const amount of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(canRedeem(voucher(), { amount }, NOW)).toEqual({
        ok: false,
        why: 'nothing-requested',
      });
    }
  });

  it('will not take half a session out of a package', () => {
    const pack = voucher({ denomination: 'units', balance: 10, serviceId: 'massage' });

    expect(canRedeem(pack, { amount: 1.5, serviceId: 'massage' }, NOW)).toEqual({
      ok: false,
      why: 'nothing-requested',
    });
  });

  it('spends a package only against what it was sold for', () => {
    const pack = voucher({ denomination: 'units', balance: 10, serviceId: 'massage' });

    expect(canRedeem(pack, { amount: 1, serviceId: 'massage' }, NOW)).toEqual({ ok: true });

    // A course of physiotherapy is not ten haircuts.
    expect(canRedeem(pack, { amount: 1, serviceId: 'haircut' }, NOW)).toEqual({
      ok: false,
      why: 'wrong-service',
    });

    // And it cannot be spent against nothing in particular either.
    expect(canRedeem(pack, { amount: 1 }, NOW)).toEqual({ ok: false, why: 'wrong-service' });
  });

  it('lets a gift voucher be spent on anything, which is what makes it a gift', () => {
    expect(canRedeem(voucher(), { amount: 100, serviceId: 'anything' }, NOW)).toEqual({ ok: true });
  });
});

describe('what a voucher can pay towards a bill', () => {
  it('pays the whole bill when it covers it', () => {
    expect(applicable(voucher(), 15_000, NOW)).toBe(15_000);
  });

  it('pays what it has, and the customer pays the rest', () => {
    /*
     * A voucher for 200 against a bill of 350 pays 200. Refusing it for not
     * covering the whole thing is absurd, and it is exactly where a
     * "can I redeem this" boolean quietly leads.
     */
    expect(applicable(voucher({ balance: 20_000 }), 35_000, NOW)).toBe(20_000);
  });

  it('pays nothing from an expired or cancelled one', () => {
    expect(applicable(voucher({ expiresAt: NOW - 1 }), 5_000, NOW)).toBe(0);
    expect(applicable(voucher({ cancelledAt: NOW - 1 }), 5_000, NOW)).toBe(0);
  });

  it('pays nothing from a package, because sessions are not money', () => {
    expect(applicable(voucher({ denomination: 'units', balance: 10 }), 5_000, NOW)).toBe(0);
  });
});

describe('when it runs out', () => {
  it('never, unless the business says otherwise', () => {
    /*
     * Expiry rules for stored value differ by jurisdiction and several treat an
     * unused gift voucher as the customer's money for years. A product that
     * invented a period would be writing off somebody else's money on a guess.
     */
    expect(expiryFrom(NOW, null)).toBeNull();
    expect(expiryFrom(NOW, 0)).toBeNull();
  });

  it('counts whole months from the day it was issued', () => {
    const at = expiryFrom(Date.UTC(2026, 0, 15), 12);

    expect(new Date(at!).toISOString().slice(0, 10)).toBe('2027-01-15');
  });

  it('clamps the 31st onto the last day of a shorter month', () => {
    /*
     * Adding a month to 31 January lands on 3 March if nothing stops it, which
     * gives the customer two extra days — or, going the other way, takes some
     * away. The last day of the month it landed in is what everybody means.
     */
    const at = expiryFrom(Date.UTC(2026, 0, 31), 1);

    expect(new Date(at!).toISOString().slice(0, 10)).toBe('2026-02-28');
  });
});
