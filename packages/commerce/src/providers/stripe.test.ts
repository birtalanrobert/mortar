import { describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { StripeConnect } from './stripe';

/**
 * The vendor's shapes, reduced to the questions this product asks.
 *
 * Nothing here tests Stripe. What is asserted is the *interpretation* — the
 * places where the vendor's vocabulary and this product's differ, which is
 * where a mistake would be invisible and expensive.
 */
describe('reading Stripe’s answers', () => {
  const connect = (client: unknown) =>
    new StripeConnect({ secretKey: 'sk_test', client: client as Stripe });

  describe('an account', () => {
    const accountFor = (fields: Record<string, unknown>) =>
      connect({
        accounts: { retrieve: vi.fn().mockResolvedValue({ id: 'acct_1', ...fields }) },
      }).account('acct_1', 'RO');

    it('is ready only when it can both charge and be paid out', async () => {
      /*
       * A business that can take money but cannot be paid out is *worse* than
       * one that cannot sell yet: the customer is charged, the money sits with
       * the provider, and the first anybody hears is the business asking where
       * it went.
       */
      expect((await accountFor({ charges_enabled: true, payouts_enabled: true })).status).toBe(
        'ready',
      );

      expect((await accountFor({ charges_enabled: true, payouts_enabled: false })).status).not.toBe(
        'ready',
      );
    });

    it('is pending while the provider simply has not finished', async () => {
      expect((await accountFor({ charges_enabled: false, payouts_enabled: false })).status).toBe(
        'pending',
      );
    });

    it('is restricted, with what is wanted, when something is outstanding', async () => {
      const account = await accountFor({
        charges_enabled: false,
        payouts_enabled: false,
        requirements: {
          currently_due: ['individual.verification.document'],
          past_due: ['individual.verification.document', 'external_account'],
        },
      });

      expect(account.status).toBe('restricted');

      /*
       * The provider's own words, and each of them once.
       *
       * "A photograph of the director's identity document" is actionable;
       * "restricted" is a support conversation — and the difference is a
       * business finishing onboarding on a Sunday evening rather than on
       * Tuesday when somebody telephones them.
       */
      expect(account.requirements).toEqual([
        'individual.verification.document',
        'external_account',
      ]);
    });
  });

  describe('a payment', () => {
    const chargeWith = (intent: Record<string, unknown>) =>
      connect({
        paymentIntents: { create: vi.fn().mockResolvedValue(intent) },
      }).charge({
        account: 'acct_1',
        amount: 4_500,
        currency: 'RON',
        applicationFee: 0,
        subject: 'booking:1',
        capture: true,
        reference: 'ref-1',
      });

    it('reads a hold as authorised rather than as taken', async () => {
      // The anti-no-show mechanism: the card is held and charged only if a fee
      // is actually applied, and that decision is a human one.
      expect((await chargeWith({ id: 'pi_1', status: 'requires_capture' })).state).toBe(
        'authorized',
      );
    });

    it('reads a success as taken', async () => {
      expect((await chargeWith({ id: 'pi_1', status: 'succeeded' })).state).toBe('captured');
    });

    it('carries a redirect rather than treating it as a failure', async () => {
      /*
       * 3-D Secure and bank redirects are the ordinary case in both target
       * markets rather than an exception, so a charge that needs the customer
       * back is pending — not failed.
       */
      const result = await chargeWith({
        id: 'pi_1',
        status: 'requires_action',
        next_action: { redirect_to_url: { url: 'https://bank.example/3ds' } },
      });

      expect(result.state).toBe('pending');
      expect(result.redirectUrl).toBe('https://bank.example/3ds');
    });

    it('describes the card in words a person recognises', async () => {
      const result = await chargeWith({
        id: 'pi_1',
        status: 'succeeded',
        latest_charge: { payment_method_details: { card: { brand: 'visa', last4: '4242' } } },
      });

      // Never the number, never anything chargeable from a database dump.
      expect(result.instrument).toBe('visa ending 4242');
    });

    it('turns a refusal into a result rather than an exception', async () => {
      const refused = connect({
        paymentIntents: {
          create: vi.fn().mockRejectedValue(new Error('Your card was declined.')),
        },
      });

      const result = await refused.charge({
        account: 'acct_1',
        amount: 4_500,
        currency: 'RON',
        applicationFee: 0,
        subject: 'booking:1',
        capture: true,
        reference: 'ref-1',
      });

      // A declined card is an ordinary outcome of a booking page, not an
      // exception for a controller to translate.
      expect(result.state).toBe('failed');
      expect(result.detail).toContain('declined');
    });

    it('sends the money to the business, with our fee on top', async () => {
      const create = vi.fn().mockResolvedValue({ id: 'pi_1', status: 'succeeded' });

      await connect({ paymentIntents: { create } }).charge({
        account: 'acct_business',
        amount: 4_500,
        currency: 'RON',
        applicationFee: 200,
        subject: 'booking:1',
        capture: true,
        reference: 'ref-1',
      });

      const [body, options] = create.mock.calls[0] as [
        Record<string, unknown>,
        { idempotencyKey: string },
      ];

      /*
       * A destination charge: the money lands on the business's account and our
       * cut is an application fee. This is the line that keeps us a software
       * company rather than a regulated one.
       */
      expect(body.transfer_data).toEqual({ destination: 'acct_business' });
      expect(body.application_fee_amount).toBe(200);

      // And the provider's own idempotency, so a double submit on a slow
      // connection does not charge somebody twice.
      expect(options.idempotencyKey).toBe('ref-1');
    });

    it('hands back what the browser needs to finish paying', async () => {
      /*
       * A charge created here has no card attached to it yet — the number is
       * entered against Stripe's own script so that it never reaches us.
       * Dropping the secret produces a payment that can be created and never
       * paid, which a customer reads as "it took my booking and lost my money".
       */
      const result = await chargeWith({
        id: 'pi_1',
        status: 'requires_payment_method',
        client_secret: 'pi_1_secret_x',
      });

      expect(result.clientSecret).toBe('pi_1_secret_x');
      expect(result.state).toBe('pending');
    });

    it('charges a stored card with nobody present, and asks for no redirect', async () => {
      const create = vi.fn().mockResolvedValue({ id: 'pi_2', status: 'succeeded' });

      await connect({ paymentIntents: { create } }).charge({
        account: 'acct_business',
        customer: 'cus_1',
        paymentMethod: 'pm_1',
        amount: 5_000,
        currency: 'RON',
        applicationFee: 0,
        subject: 'booking:1',
        capture: true,
        reference: 'fee-1',
      });

      const [body] = create.mock.calls[0] as [Record<string, unknown>];

      /*
       * `off_session` is what tells the network nobody is sitting there — and
       * what makes a bank decline rather than ask for a code it has nobody to
       * ask. That is the honest outcome for a fee charged three days later.
       */
      expect(body).toMatchObject({ customer: 'cus_1', payment_method: 'pm_1', off_session: true });
      expect(body.confirm).toBe(true);

      // Offering a redirect method to a charge already confirmed against a
      // stored card is a contradiction the provider rejects.
      expect(body.automatic_payment_methods).toBeUndefined();
    });
  });

  describe('a card kept for later', () => {
    it('creates the customer on our account, not the business\u2019s', async () => {
      /*
       * Under a destination charge the money lands on the business's account
       * while the card stays ours to charge. A customer created on the
       * business's account cannot be used from here at all.
       */
      const customers = { create: vi.fn().mockResolvedValue({ id: 'cus_new' }) };
      const create = vi.fn().mockResolvedValue({ id: 'seti_1', client_secret: 'seti_1_secret_x' });

      const result = await connect({
        customers,
        setupIntents: { create },
      }).saveCard({ subject: 'customer:7', reference: 'card-7' });

      expect(result.customer).toBe('cus_new');
      expect(result.clientSecret).toBe('seti_1_secret_x');

      const [body] = create.mock.calls[0] as [Record<string, unknown>];

      // Off-session, because the whole point is charging it when the person is
      // not there.
      expect(body).toMatchObject({ customer: 'cus_new', usage: 'off_session' });
    });

    it('joins a second card to the customer somebody already has', async () => {
      const customers = { create: vi.fn() };

      await connect({
        customers,
        setupIntents: { create: vi.fn().mockResolvedValue({ id: 'seti_2', client_secret: 's' }) },
      }).saveCard({ subject: 'customer:7', customer: 'cus_existing', reference: 'card-8' });

      // Otherwise a person acquires a stranger with their own name every time
      // they add a card, and their first one becomes unreachable.
      expect(customers.create).not.toHaveBeenCalled();
    });

    it('reads back only enough of the card to recognise it', async () => {
      const stored = await connect({
        setupIntents: {
          retrieve: vi.fn().mockResolvedValue({
            id: 'seti_1',
            customer: 'cus_1',
            payment_method: {
              id: 'pm_1',
              card: { brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2030 },
            },
          }),
        },
      }).storedCard('seti_1');

      expect(stored).toEqual({
        customer: 'cus_1',
        paymentMethod: 'pm_1',
        brand: 'visa',
        last4: '4242',
        expiryMonth: 4,
        expiryYear: 2030,
      });
    });

    it('reports nothing stored when the browser never finished', async () => {
      /*
       * Read back from the provider rather than believed from the browser: what
       * a page reports is what a page was told to report, and this is a row a
       * business will later charge real money against.
       */
      const stored = await connect({
        setupIntents: {
          retrieve: vi.fn().mockResolvedValue({ id: 'seti_1', customer: 'cus_1' }),
        },
      }).storedCard('seti_1');

      expect(stored).toBeUndefined();
    });
  });

  describe('a webhook', () => {
    const withSecret = (constructEvent: unknown) =>
      new StripeConnect({
        secretKey: 'sk_test',
        webhookSecret: 'whsec_test',
        client: { webhooks: { constructEvent } } as unknown as Stripe,
      });

    it('is ignored when it is not signed', () => {
      const connect = withSecret(vi.fn());
      expect(connect.verify('{}', undefined)).toBeUndefined();
    });

    it('is ignored when the signature does not check out', () => {
      /*
       * `undefined` rather than a thrown error: the caller answers a request
       * that did not come from Stripe with a flat acknowledgement, not with a
       * message describing what was wrong with the forgery.
       */
      const connect = withSecret(
        vi.fn(() => {
          throw new Error('No signatures found matching the expected signature');
        }),
      );

      expect(connect.verify('{}', 'v1=nonsense')).toBeUndefined();
    });

    it('reads a completed payment', () => {
      const connect = withSecret(
        vi.fn().mockReturnValue({
          type: 'payment_intent.succeeded',
          data: { object: { id: 'pi_1', status: 'succeeded' } },
        }),
      );

      expect(connect.verify('{}', 'v1=ok')).toMatchObject({
        kind: 'payment',
        externalId: 'pi_1',
        state: 'captured',
      });
    });

    it('reads a refund against the payment it belongs to', () => {
      const connect = withSecret(
        vi.fn().mockReturnValue({
          type: 'charge.refunded',
          data: { object: { id: 'ch_1', payment_intent: 'pi_1' } },
        }),
      );

      // Named by the intent, because that is what our own row records.
      expect(connect.verify('{}', 'v1=ok')).toMatchObject({
        externalId: 'pi_1',
        state: 'refunded',
      });
    });

    it('acknowledges an event it has no opinion about', () => {
      /*
       * Stripe sends a great many event types and a deployment's subscription
       * drifts. Treating an unknown one as an error means retries and an alert
       * for something that was never any of our business.
       */
      const connect = withSecret(
        vi.fn().mockReturnValue({ type: 'invoice.paid', id: 'evt_1', data: { object: {} } }),
      );

      expect(connect.verify('{}', 'v1=ok')?.kind).toBe('other');
    });
  });
});
