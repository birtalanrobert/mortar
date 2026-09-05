import { describe, expect, it } from 'vitest';
import { mayUse, usageCost, type UsageRate } from './usage';

const sms: UsageRate = { meter: 'sms_segment', included: 500, unitPrice: 12 };

describe('metered usage', () => {
  it('costs nothing inside the allowance', () => {
    expect(usageCost(sms, 500)).toBe(0);
    expect(usageCost(sms, 0)).toBe(0);
  });

  it('charges only what is past it', () => {
    expect(usageCost(sms, 700)).toBe(200 * 12);
  });

  it('lets a business stop rather than be charged, if that is what it chose', () => {
    /*
     * The tenant's decision, not ours. A salon that would rather stop sending
     * than be charged is making a reasonable choice about its own margin, and a
     * product that silently tops up appears on a card statement as a surprise.
     */
    expect(mayUse(sms, 700, 'block')).toBe(false);
    expect(mayUse(sms, 700, 'charge')).toBe(true);
  });

  it('lets a blocked business spend a balance it has already bought', () => {
    expect(mayUse(sms, 700, 'block', 300)).toBe(true);
  });

  it('always allows what the allowance covers', () => {
    expect(mayUse(sms, 499, 'block')).toBe(true);
  });
});
