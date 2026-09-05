import { describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { StripeBilling } from './stripe';

/**
 * The vendor's shapes, reduced to the questions this package asks.
 *
 * Nothing here tests Stripe. What is asserted is the *interpretation* — the
 * places where the vendor's vocabulary and ours differ, which is where a
 * mistake is invisible until an invoice is wrong.
 */
describe('reading Stripe’s answers', () => {
  const billing = (client: unknown) =>
    new StripeBilling({ secretKey: 'sk_test', client: client as Stripe });

  const subscription = (fields: Record<string, unknown>) => ({
    id: 'sub_1',
    items: { data: [{ id: 'si_1', quantity: 3, current_period_end: 1_800_000_000 }] },
    cancel_at: null,
    ...fields,
  });

  describe('a subscription', () => {
    const statusOf = async (status: string) =>
      (await billing({
        subscriptions: { retrieve: vi.fn().mockResolvedValue(subscription({ status })) },
      }).subscription('sub_1'))!.status;

    it('reads a payment being authenticated as active, not as unpaid', async () => {
      /*
       * `incomplete` means a 3-D Secure challenge the customer is in the middle
       * of. Treating it as unpaid switches the product off in the thirty
       * seconds between paying and the bank answering.
       */
      expect(await statusOf('incomplete')).toBe('active');
    });

    it('reads both of the provider’s unpaid words as past due', async () => {
      expect(await statusOf('past_due')).toBe('past_due');
      expect(await statusOf('unpaid')).toBe('past_due');
    });

    it('distinguishes a paused subscription from a cancelled one', async () => {
      // A seasonal business asks to stop paying without losing anything; the
      // alternative it takes otherwise is cancelling for good.
      expect(await statusOf('paused')).toBe('paused');
      expect(await statusOf('canceled')).toBe('cancelled');
      expect(await statusOf('incomplete_expired')).toBe('cancelled');
    });

    it('reads the period from the item, which is where it now lives', async () => {
      const read = await billing({
        subscriptions: { retrieve: vi.fn().mockResolvedValue(subscription({ status: 'active' })) },
      }).subscription('sub_1');

      expect(read?.currentPeriodEnd.getTime()).toBe(1_800_000_000_000);
      expect(read?.quantity).toBe(3);
    });

    it('reports nothing for one that belongs to another environment', async () => {
      /*
       * Several deployments share a provider account in test mode. A
       * subscription we cannot read is not an error to put on a screen.
       */
      const read = await billing({
        subscriptions: { retrieve: vi.fn().mockRejectedValue(new Error('No such subscription')) },
      }).subscription('sub_missing');

      expect(read).toBeUndefined();
    });
  });

  describe('starting a subscription', () => {
    it('lets the provider work out the tax, and carries the subject through', async () => {
      const create = vi.fn().mockResolvedValue({ id: 'cs_1', url: 'https://pay.test/cs_1' });

      await billing({ checkout: { sessions: { create } } }).checkout({
        customer: 'cus_1',
        mode: 'subscription',
        price: 'price_1',
        quantity: 4,
        trialDays: 14,
        successUrl: 'https://console.test/done',
        cancelUrl: 'https://console.test/plans',
        subject: 'tenant:abc',
        reference: 'checkout-abc',
      });

      const [body, options] = create.mock.calls[0] as [
        Record<string, unknown>,
        { idempotencyKey: string },
      ];

      /*
       * Both markets tax a digital subscription by where the customer is, and a
       * rate table maintained by hand is wrong from the first budget the
       * finance ministry passes.
       */
      expect(body.automatic_tax).toEqual({ enabled: true });

      /*
       * On the subscription as well as the session: the session's metadata does
       * not survive onto what it creates, and the webhook that matters arrives
       * about the subscription.
       */
      expect(body.subscription_data).toMatchObject({
        metadata: { subject: 'tenant:abc' },
        trial_period_days: 14,
      });

      expect(options.idempotencyKey).toBe('checkout-abc');
    });
  });

  describe('changing how many are being paid for', () => {
    it('prorates onto the next invoice rather than charging separately', async () => {
      const update = vi.fn().mockResolvedValue(subscription({ status: 'active' }));

      await billing({
        subscriptions: {
          retrieve: vi.fn().mockResolvedValue(subscription({ status: 'active' })),
          update,
        },
      }).setQuantity('sub_1', 7);

      const [, body] = update.mock.calls[0] as [string, Record<string, unknown>];

      /*
       * A salon that hires somebody on the twentieth pays for eleven days —
       * with everything else, rather than as a card charge nobody expected.
       */
      expect(body.proration_behavior).toBe('create_prorations');
      expect(body.items).toEqual([{ id: 'si_1', quantity: 7 }]);
    });
  });

  describe('cancelling', () => {
    it('stops at the end of what was paid for, by default', async () => {
      const update = vi.fn().mockResolvedValue(subscription({ status: 'active' }));

      await billing({
        subscriptions: { retrieve: vi.fn(), update, cancel: vi.fn() },
      }).cancel('sub_1', false);

      /*
       * Somebody cancelling in the first week has paid for the month, and
       * taking the product away that afternoon turns a cancellation into a
       * refund request and a review.
       */
      expect(update.mock.calls[0]?.[1]).toEqual({ cancel_at_period_end: true });
    });
  });

  describe('reporting usage', () => {
    it('sends it against the customer, with a reference the provider de-duplicates', async () => {
      const create = vi.fn().mockResolvedValue({});

      await billing({ billing: { meterEvents: { create } } }).reportUsage({
        customer: 'cus_1',
        meter: 'sms_segment',
        quantity: 412,
        at: new Date('2026-03-04T12:00:00Z'),
        reference: 'abc-sms_segment-2026-03-04',
      });

      const [body] = create.mock.calls[0] as [Record<string, unknown>];

      expect(body).toMatchObject({
        event_name: 'sms_segment',
        payload: { stripe_customer_id: 'cus_1', value: '412' },
        identifier: 'abc-sms_segment-2026-03-04',
      });

      // A nightly aggregation that runs twice would otherwise bill a venue for
      // its tickets twice, and the customer finds it before we do.
      expect(body.timestamp).toBe(1_772_625_600);
    });
  });

  describe('a webhook', () => {
    it('is refused when there is no secret to check it against', () => {
      // An endpoint that trusts an unsigned request is one anybody can use to
      // mark a subscription as paid.
      expect(billing({}).verify('{}', 'v1=whatever')).toBeUndefined();
    });

    /** A client that will accept a signature, returning the event given. */
    const withSecret = (event: Record<string, unknown>) =>
      new StripeBilling({
        secretKey: 'sk_test',
        webhookSecret: 'whsec',
        client: {
          webhooks: { constructEvent: vi.fn().mockReturnValue(event) },
        } as unknown as Stripe,
      });

    it('reads an unpaid invoice as an invoice event, with what it came to', () => {
      const client = withSecret({
        id: 'evt_1',
        type: 'invoice.payment_failed',
        data: { object: { id: 'in_1', amount_due: 14_900, currency: 'ron' } },
      });

      expect(client.verify('{}', 'v1=ok')).toMatchObject({
        kind: 'invoice',
        externalId: 'in_1',
        paid: false,
        amount: 14_900,
        currency: 'RON',
      });
    });

    it('carries the tenant back from a subscription event', () => {
      /*
       * Set on the way out precisely so this is possible without a lookup table
       * of our own — a webhook otherwise arrives naming the provider's
       * identifiers and nothing of ours.
       */
      const client = withSecret({
        id: 'evt_3',
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_1',
            status: 'active',
            metadata: { subject: 'tenant:abc' },
            items: { data: [{ id: 'si_1', quantity: 2, current_period_end: 1_800_000_000 }] },
            cancel_at: null,
          },
        },
      });

      expect(client.verify('{}', 'v1=ok')).toMatchObject({
        kind: 'subscription',
        subject: 'tenant:abc',
        subscription: { status: 'active', quantity: 2 },
      });
    });

    it('acknowledges an event it has no opinion about', () => {
      /*
       * Stripe sends a great many event types and a deployment's subscription
       * drifts. Treating an unknown one as an error means retries and an alert
       * for something that was never any of our business.
       */
      const client = withSecret({ id: 'evt_2', type: 'charge.refunded', data: { object: {} } });

      expect(client.verify('{}', 'v1=ok')?.kind).toBe('other');
    });
  });
});
