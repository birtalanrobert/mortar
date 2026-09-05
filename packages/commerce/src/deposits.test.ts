import { describe, expect, it } from 'vitest';
import {
  balanceAfter,
  canTakeMoney,
  depositFor,
  payoutBlockReason,
  type DepositPolicy,
} from './deposits';

const percentage = (value: number): DepositPolicy => ({ kind: 'percentage', value });

describe('depositFor', () => {
  it('takes nothing when the business asks for nothing', () => {
    expect(depositFor(15_000, { kind: 'none', value: 0 })).toBe(0);
  });

  it('takes the whole price for full prepayment', () => {
    expect(depositFor(15_000, { kind: 'full', value: 0 })).toBe(15_000);
  });

  it('takes a percentage the way a person would work it out', () => {
    // 30% of 150,00 is 45,00 — the number the console shows while somebody
    // drags the slider, and the number the charge has to be.
    expect(depositFor(15_000, percentage(30))).toBe(4_500);
  });

  it('rounds a fraction of a ban to the nearest one', () => {
    // 30% of 33,33 is 9,999 bani. A provider takes integers.
    expect(depositFor(3_333, percentage(30))).toBe(1_000);
  });

  it('never asks for more than the thing costs', () => {
    /*
     * A misconfigured 150% is a configuration mistake, and taking more than the
     * price is the worst possible way to surface it — the customer finds out,
     * not the business.
     */
    expect(depositFor(15_000, percentage(150))).toBe(15_000);
    expect(depositFor(15_000, { kind: 'fixed', value: 99_999 })).toBe(15_000);
  });

  it('never asks for a negative amount', () => {
    expect(depositFor(15_000, percentage(-10))).toBe(0);
    expect(depositFor(15_000, { kind: 'fixed', value: -500 })).toBe(0);
  });

  it('asks for nothing against a free service', () => {
    // A consultation at no charge with a 30% deposit policy is not a bill for
    // nothing; it is no bill.
    expect(depositFor(0, percentage(30))).toBe(0);
  });

  it('takes a fixed amount as it was typed', () => {
    expect(depositFor(15_000, { kind: 'fixed', value: 5_000 })).toBe(5_000);
  });
});

describe('balanceAfter', () => {
  it('is what is still owed', () => {
    expect(balanceAfter(15_000, 4_500)).toBe(10_500);
  });

  it('is never negative, whatever was paid', () => {
    // An overpayment is a refund conversation, not a negative balance shown to
    // somebody at a counter.
    expect(balanceAfter(15_000, 20_000)).toBe(0);
  });
});

describe('the payout gate', () => {
  it('lets money be taken only once the provider has verified the business', () => {
    /*
     * Funds go directly to the business and our fee is taken on top, so until
     * the provider knows who they are there is nowhere for the money to go.
     */
    expect(canTakeMoney('ready')).toBe(true);
    for (const status of ['none', 'pending', 'restricted'] as const) {
      expect(canTakeMoney(status)).toBe(false);
    }
  });

  it('says why not, as a key rather than a sentence', () => {
    // The words belong to whichever product is showing them; a package that
    // shipped English into a Romanian console would be worse than one that
    // shipped nothing.
    expect(payoutBlockReason('none')).toBe('not-started');
    expect(payoutBlockReason('pending')).toBe('in-progress');
    expect(payoutBlockReason('restricted')).toBe('needs-attention');
    expect(payoutBlockReason('ready')).toBeNull();
  });
});
