import { describe, expect, it } from 'vitest';
import { canCommit, dunningStage, isEntitled, proratedFor } from './subscriptions';

describe('whether the product should work', () => {
  it('keeps working while a payment is merely late', () => {
    /*
     * The decision that matters most here, and it is commercial rather than
     * technical. A card expires on a Sunday and nobody reads the email until
     * Tuesday; a salon whose diary stopped in between has lost bookings it
     * cannot recover, over an amount it fully intended to pay.
     */
    expect(isEntitled('past_due')).toBe(true);
    expect(isEntitled('trialing')).toBe(true);
    expect(isEntitled('active')).toBe(true);
  });

  it('stops for somebody who has left or paused', () => {
    expect(isEntitled('cancelled')).toBe(false);
    expect(isEntitled('paused')).toBe(false);
    expect(isEntitled('none')).toBe(false);
  });

  it('separates running today from taking on more', () => {
    /*
     * The distinction that keeps a lapse from being a catastrophe: an unpaid
     * business keeps everything it has and can still run today, but stops
     * accumulating work we would then have to hand back.
     */
    expect(isEntitled('past_due')).toBe(true);
    expect(canCommit('past_due')).toBe(false);
  });
});

describe('how hard to push about an unpaid invoice', () => {
  it('does nothing on the day itself', () => {
    expect(dunningStage(0)).toBe('none');
  });

  it('escalates slowly, because most failures are an expired card', () => {
    expect(dunningStage(1)).toBe('remind');
    expect(dunningStage(5)).toBe('warn');
    expect(dunningStage(10)).toBe('restrict');
    expect(dunningStage(30)).toBe('suspend');
  });
});

describe('a period only partly used', () => {
  it('charges by the day, rounded down', () => {
    // Rounded down because the alternative is explaining a rounding to
    // somebody already unhappy about a change they did not expect.
    expect(proratedFor(14_900, 15, 30)).toBe(7_450);
    expect(proratedFor(10_000, 1, 3)).toBe(3_333);
  });

  it('never goes negative, and never exceeds the whole period', () => {
    expect(proratedFor(14_900, -5, 30)).toBe(0);
    expect(proratedFor(14_900, 45, 30)).toBe(14_900);
    expect(proratedFor(14_900, 5, 0)).toBe(0);
  });
});
