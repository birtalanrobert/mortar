import { describe, expect, it } from 'vitest';
import { hasFeature, limitFor, priceFor, withinLimit, type Plan } from './plans';

/** A two-chair barbershop's plan: five staff included, then graduated bands. */
const plan: Plan = {
  code: 'salon',
  name: 'Salon',
  interval: 'month',
  currency: 'RON',
  basePrice: 14_900,
  includedQuantity: 5,
  tiers: [
    { upTo: 15, unitPrice: 2_000 },
    { upTo: 50, unitPrice: 1_500 },
    { upTo: null, unitPrice: 1_000 },
  ],
  limits: { locations: 1, staff: null, smsSegments: 500 },
  features: ['reminders', 'onlineBooking'],
  trialDays: 14,
};

describe('what a plan costs', () => {
  it('is the base price while the quantity is included', () => {
    expect(priceFor(plan, 0)).toBe(14_900);
    expect(priceFor(plan, 5)).toBe(14_900);
  });

  it('charges only the units past the allowance, band by band', () => {
    /*
     * Graduated, not volume: "up to five included, then twenty lei each" means
     * twenty for the sixth — not twenty for all six. Both shapes exist in the
     * wild and only one matches how these products are described.
     */
    expect(priceFor(plan, 6)).toBe(14_900 + 2_000);
    expect(priceFor(plan, 15)).toBe(14_900 + 10 * 2_000);
    expect(priceFor(plan, 20)).toBe(14_900 + 10 * 2_000 + 5 * 1_500);
  });

  it('keeps charging past the last band at the last band’s rate', () => {
    /*
     * The alternative is a plan that silently stops charging for the
     * two-hundredth employee, and nobody notices until the invoice has been
     * wrong in the customer's favour for a year.
     */
    expect(priceFor(plan, 100)).toBe(14_900 + 10 * 2_000 + 35 * 1_500 + 50 * 1_000);
  });

  it('rounds a fractional quantity up, because half a seat is a seat', () => {
    expect(priceFor(plan, 5.2)).toBe(14_900 + 2_000);
  });

  it('is the base price for a flat plan, whatever the quantity', () => {
    const flat: Plan = { ...plan, includedQuantity: 0, tiers: [] };
    expect(priceFor(flat, 40)).toBe(14_900);
  });
});

describe('what a plan permits', () => {
  it('treats an absent limit as no limit, not as zero', () => {
    /*
     * The failure this prevents: a plan that forgot to mention `bookings`
     * silently permitting none of them, which reads to the business as the
     * product being broken.
     */
    expect(limitFor(plan, 'bookings')).toBeNull();
    expect(withinLimit(plan, 'bookings', 10_000)).toBe(true);
  });

  it('says no on the boundary rather than one past it', () => {
    expect(withinLimit(plan, 'locations', 0)).toBe(true);
    expect(withinLimit(plan, 'locations', 1)).toBe(false);
  });

  it('treats `null` as unlimited, which is a real answer', () => {
    expect(withinLimit(plan, 'staff', 9_999)).toBe(true);
  });

  it('gates on presence, because there is no deny list', () => {
    expect(hasFeature(plan, 'reminders')).toBe(true);
    expect(hasFeature(plan, 'payments')).toBe(false);
  });
});
