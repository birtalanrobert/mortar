import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
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

  describe('selling a single payment by its amount', () => {
    const pack = {
      customer: 'cus_1',
      mode: 'payment' as const,
      price: {
        amount: 999,
        currency: 'EUR',
        name: 'A purse: 260 Silver',
        taxBehavior: 'inclusive' as const,
        taxCode: 'txcd_10000000',
      },
      successUrl: 'https://game.test/silver?bought',
      cancelUrl: 'https://game.test/silver',
      subject: 'account:abc',
      reference: 'checkout-1',
      metadata: { purchase: 'p-1', package: 'purse' },
      locale: 'hu',
    };

    it('charges the amount the product shows, the tax inside it, as the payment page says', async () => {
      const create = vi.fn().mockResolvedValue({ id: 'cs_1', url: 'https://pay.test/cs_1' });

      expect(await billing({ checkout: { sessions: { create } } }).checkout(pack)).toEqual({
        url: 'https://pay.test/cs_1',
        externalId: 'cs_1',
      });
      const [body, options] = create.mock.calls[0] as [
        Record<string, unknown>,
        { idempotencyKey: string },
      ];

      /*
       * A price an operator edits in the product's settings is charged as
       * written: no price in the provider's dashboard to drift from it. A
       * consumer price already holds its VAT, which the provider works out.
       */
      expect(body.line_items).toEqual([
        {
          price_data: {
            currency: 'eur',
            unit_amount: 999,
            tax_behavior: 'inclusive',
            product_data: { name: 'A purse: 260 Silver', tax_code: 'txcd_10000000' },
          },
          quantity: 1,
        },
      ]);
      expect(body.automatic_tax).toEqual({ enabled: true });
      expect(body.locale).toBe('hu');
      expect(options.idempotencyKey).toBe('checkout-1');
    });

    it('carries the caller’s own metadata onto the payment too, which a refund or a dispute names', async () => {
      const create = vi.fn().mockResolvedValue({ id: 'cs_1', url: 'https://pay.test/cs_1' });

      await billing({ checkout: { sessions: { create } } }).checkout(pack);
      const [body] = create.mock.calls[0] as [Record<string, unknown>];

      const metadata = { purchase: 'p-1', package: 'purse', subject: 'account:abc' };
      expect(body.metadata).toEqual(metadata);
      expect(body.payment_intent_data).toEqual({ metadata });
      expect(body.subscription_data).toBeUndefined();
    });

    it('refuses an amount for a subscription, whose recurring price is the plan’s own', async () => {
      const create = vi.fn();

      await expect(
        billing({ checkout: { sessions: { create } } }).checkout({ ...pack, mode: 'subscription' }),
      ).rejects.toThrow(RangeError);
      expect(create).not.toHaveBeenCalled();
    });
  });

  describe('refunding a single payment', () => {
    const refundOf = (status: string) =>
      billing({
        refunds: { create: vi.fn().mockResolvedValue({ id: 're_1', status, amount: 999 }) },
      }).refund({ payment: 'pi_1', reference: 'refund-p-1' });

    it('returns the payment’s money under a reference the provider holds it to', async () => {
      const create = vi.fn().mockResolvedValue({ id: 're_1', status: 'succeeded', amount: 400 });

      expect(
        await billing({ refunds: { create } }).refund({
          payment: 'pi_1',
          amount: 400,
          reference: 'refund-p-1',
        }),
      ).toEqual({ externalId: 're_1', status: 'succeeded', amount: 400 });
      // Asked again after a timeout, the money is returned once.
      expect(create).toHaveBeenCalledWith(
        { payment_intent: 'pi_1', amount: 400 },
        { idempotencyKey: 'refund-p-1' },
      );
    });

    it('returns all of it when no amount is given', async () => {
      const create = vi.fn().mockResolvedValue({ id: 're_1', status: 'pending', amount: 999 });

      await billing({ refunds: { create } }).refund({ payment: 'pi_1', reference: 'r' });
      expect(create.mock.calls[0]?.[0]).toEqual({ payment_intent: 'pi_1' });
    });

    it('reads a refund waiting on the buyer’s bank as on its way, and a cancelled one as failed', async () => {
      expect((await refundOf('requires_action')).status).toBe('pending');
      expect((await refundOf('pending')).status).toBe('pending');
      expect((await refundOf('canceled')).status).toBe('failed');
      expect((await refundOf('failed')).status).toBe('failed');
    });
  });

  describe('deleting a customer', () => {
    it('asks the provider to forget them', async () => {
      const del = vi.fn().mockResolvedValue({ id: 'cus_1', deleted: true });

      await billing({ customers: { del } }).deleteCustomer('cus_1');

      expect(del).toHaveBeenCalledWith('cus_1');
    });

    it('takes one the provider no longer has as forgotten, and throws on anything else', async () => {
      const missing = Object.assign(new Error('No such customer'), { code: 'resource_missing' });
      await expect(
        billing({ customers: { del: vi.fn().mockRejectedValue(missing) } }).deleteCustomer('cus_1'),
      ).resolves.toBeUndefined();

      const down = Object.assign(new Error('Service unavailable'), { code: 'api_error' });
      await expect(
        billing({ customers: { del: vi.fn().mockRejectedValue(down) } }).deleteCustomer('cus_1'),
      ).rejects.toBe(down);
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
        data: { object: { id: 'in_1', customer: 'cus_1', amount_due: 14_900, currency: 'ron' } },
      });

      expect(client.verify('{}', 'v1=ok')).toMatchObject({
        kind: 'invoice',
        externalId: 'in_1',
        paid: false,
        amount: 14_900,
        currency: 'RON',
      });
    });

    it('carries the tenant from the subscription’s metadata onto the invoice', () => {
      /*
       * The only thing that makes an invoice event actionable. Its own
       * identifier is one we have never seen, and the subscriptions table that
       * could translate the customer into a tenant is under row-level security
       * — an unbound read of it returns *no rows* rather than an error, so the
       * event would verify, read, be understood and change nothing.
       */
      const client = withSecret({
        id: 'evt_6',
        type: 'invoice.payment_failed',
        data: {
          object: {
            id: 'in_4',
            customer: 'cus_1',
            amount_due: 14_900,
            currency: 'ron',
            subscription_details: { metadata: { subject: 'tenant:abc' } },
          },
        },
      });

      expect(client.verify('{}', 'v1=ok')?.subject).toBe('tenant:abc');
    });

    it('carries the customer, because an invoice’s own id is one we have never seen', () => {
      /*
       * The only handle an invoice event shares with anything we store. Without
       * it the event can be verified, read and understood, and still be
       * attributable to nobody — so an unpaid business runs on for ever with
       * nothing in any log to say why.
       */
      const client = withSecret({
        id: 'evt_4',
        type: 'invoice.paid',
        data: { object: { id: 'in_2', customer: 'cus_7', amount_due: 0, currency: 'ron' } },
      });

      expect(client.verify('{}', 'v1=ok')?.customer).toBe('cus_7');
    });

    it('reads the customer whether it arrives expanded or as a string', () => {
      // Both appear on the same field depending on the event and the API
      // version, and a reader that assumes one finds nothing on half the
      // traffic.
      const client = withSecret({
        id: 'evt_5',
        type: 'invoice.paid',
        data: {
          object: { id: 'in_3', customer: { id: 'cus_9' }, amount_due: 0, currency: 'ron' },
        },
      });

      expect(client.verify('{}', 'v1=ok')?.customer).toBe('cus_9');
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
      const client = withSecret({ id: 'evt_2', type: 'customer.created', data: { object: {} } });

      expect(client.verify('{}', 'v1=ok')).toEqual({
        kind: 'other',
        eventId: 'evt_2',
        externalId: 'evt_2',
      });
    });

    const session = (fields: Record<string, unknown>) => ({
      id: 'cs_1',
      customer: 'cus_1',
      metadata: { subject: 'account:abc', purchase: 'p-1' },
      payment_status: 'paid',
      payment_intent: 'pi_1',
      amount_total: 999,
      currency: 'eur',
      total_details: { amount_tax: 159 },
      ...fields,
    });

    it('reads a paid checkout with its payment, its tax and the caller’s metadata, under the event’s own id', () => {
      const client = withSecret({
        id: 'evt_10',
        type: 'checkout.session.completed',
        data: { object: session({}) },
      });

      // The event's id is what a second delivery of it shares with the first.
      expect(client.verify('{}', 'v1=ok')).toEqual({
        kind: 'checkout',
        eventId: 'evt_10',
        externalId: 'cs_1',
        customer: 'cus_1',
        subject: 'account:abc',
        metadata: { subject: 'account:abc', purchase: 'p-1' },
        paid: true,
        payment: 'pi_1',
        amount: 999,
        currency: 'EUR',
        tax: 159,
      });
    });

    it('reads a checkout completed with its money still clearing as unpaid, until its own event says it paid', () => {
      /*
       * A bank debit completes the session days before the money arrives.
       * Crediting at completion would deliver what was never paid for.
       */
      const read = (type: string, payment_status: string) =>
        withSecret({
          id: 'evt_11',
          type,
          data: { object: session({ payment_status, payment_intent: { id: 'pi_2' } }) },
        }).verify('{}', 'v1=ok');

      expect(read('checkout.session.completed', 'unpaid')).toMatchObject({
        kind: 'checkout',
        paid: false,
        payment: 'pi_2',
      });
      expect(read('checkout.session.async_payment_succeeded', 'paid')?.paid).toBe(true);
      expect(read('checkout.session.async_payment_failed', 'unpaid')?.paid).toBe(false);
    });

    it('reads every refund of a payment, the provider’s dashboard’s among them, by how much has gone back', () => {
      const client = withSecret({
        id: 'evt_12',
        type: 'charge.refunded',
        data: {
          object: {
            id: 'ch_1',
            customer: 'cus_1',
            payment_intent: 'pi_1',
            metadata: {},
            amount: 999,
            amount_refunded: 500,
            currency: 'eur',
          },
        },
      });

      expect(client.verify('{}', 'v1=ok')).toEqual({
        kind: 'refund',
        eventId: 'evt_12',
        externalId: 'ch_1',
        customer: 'cus_1',
        payment: 'pi_1',
        amount: 999,
        amountRefunded: 500,
        currency: 'EUR',
      });
    });

    it('reads a dispute by the money it moves: withdrawn, and reinstated when it is won', () => {
      const read = (type: string) =>
        withSecret({
          id: 'evt_13',
          type,
          data: { object: { id: 'dp_1', payment_intent: 'pi_1', amount: 999, currency: 'eur' } },
        }).verify('{}', 'v1=ok');

      expect(read('charge.dispute.funds_withdrawn')).toEqual({
        kind: 'dispute',
        eventId: 'evt_13',
        externalId: 'dp_1',
        payment: 'pi_1',
        amount: 999,
        currency: 'EUR',
        fundsWithdrawn: true,
      });
      expect(read('charge.dispute.funds_reinstated')?.fundsWithdrawn).toBe(false);
      // An inquiry moves no money, and is none of the product's business yet.
      expect(read('charge.dispute.created')?.kind).toBe('other');
    });
  });

  describe('an API somewhere else', () => {
    it('sends every call there, as stripe-mock or a suite’s stub vendor answers them', async () => {
      const received: Array<{ method?: string; url?: string; key?: string; body: string }> = [];
      const server = createServer((incoming: IncomingMessage, answer) => {
        let body = '';
        incoming.on('data', (chunk: Buffer) => (body += chunk.toString()));
        incoming.on('end', () => {
          received.push({
            method: incoming.method,
            url: incoming.url,
            key: incoming.headers['idempotency-key'] as string | undefined,
            body,
          });
          answer.writeHead(200, { 'content-type': 'application/json' });
          answer.end(
            JSON.stringify({ id: 're_9', object: 'refund', status: 'succeeded', amount: 999 }),
          );
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const { port } = server.address() as AddressInfo;
        const refund = await new StripeBilling({
          secretKey: 'sk_test_stub',
          apiUrl: `http://127.0.0.1:${port}`,
        }).refund({ payment: 'pi_1', reference: 'refund-p-1' });

        expect(refund).toEqual({ externalId: 're_9', status: 'succeeded', amount: 999 });
        expect(received).toEqual([
          { method: 'POST', url: '/v1/refunds', key: 'refund-p-1', body: 'payment_intent=pi_1' },
        ]);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });
});
