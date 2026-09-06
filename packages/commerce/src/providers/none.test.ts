import { describe, expect, it } from 'vitest';
import { NoPayments } from './none';

/**
 * A deployment that takes no card payments at all.
 *
 * Online payment is optional in every product built on this package and never
 * mandatory. What is asserted here is that "optional" survives contact with the
 * code: a salon taking cash at the counter runs its whole diary, and nothing —
 * least of all the application starting — asks it for a payment account.
 */
describe('no payment provider at all', () => {
  const provider = new NoPayments();

  it('reports no account rather than one that is still being checked', async () => {
    /*
     * `pending` and `none` are different facts. A business told `pending` waits
     * for an email that nobody is going to send.
     */
    expect((await provider.account(null)).status).toBe('none');
  });

  it('refuses a charge instead of quietly reporting success', async () => {
    const result = await provider.charge({
      tenantId: 'tenant-1',
      account: 'acct_1',
      amount: 5_000,
      currency: 'RON',
      applicationFee: 0,
      subject: 'booking:1',
      capture: true,
      reference: 'ref-1',
    });

    /*
     * The trap this closes: a permissive no-op writes a trail of payments that
     * never happened, and a business reads its own books as money it has been
     * paid. Failing honestly is worse to look at and better to own.
     */
    expect(result.state).toBe('failed');
    expect(result.detail).toContain('cannot take card payments');
  });

  it('treats anything arriving at its webhook address as not from a provider', () => {
    expect(provider.verify()).toBeUndefined();
  });
});
