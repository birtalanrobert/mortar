import Stripe from 'stripe';
import type {
  BillingEvent,
  BillingProvider,
  CheckoutRequest,
  HostedSession,
  ProviderCustomer,
  ProviderSubscription,
} from './port';

export interface StripeBillingOptions {
  readonly secretKey: string;
  /** Without it every webhook is refused, which is the correct default. */
  readonly webhookSecret?: string;
  /** Injected in tests. Nothing else should pass one. */
  readonly client?: Stripe;
}

/**
 * Our own subscriptions, on our own Stripe account.
 *
 * **Hosted wherever hosting is possible.** Checkout collects the card and
 * calculates VAT; the customer portal changes a card, downloads an invoice and
 * cancels. Both are things Stripe already does to a standard we would not
 * match, in two tax jurisdictions whose invoice rules we would have to learn
 * and then keep up with. What stays ours is what a plan costs, what it
 * permits, and what the product does when nobody has paid — none of which
 * Stripe knows anything about.
 *
 * Not to be confused with `@birtalanrobert/commerce`'s `StripeConnect`, which
 * is the same vendor doing the opposite thing.
 */
export class StripeBilling implements BillingProvider {
  readonly name = 'stripe';

  private readonly stripe: Stripe;

  constructor(private readonly options: StripeBillingOptions) {
    this.stripe = options.client ?? new Stripe(options.secretKey);
  }

  async customer(
    externalId: string | null,
    email: string,
    name: string,
  ): Promise<ProviderCustomer> {
    if (externalId) {
      const existing = await this.stripe.customers.retrieve(externalId);

      /*
       * A deleted customer is not an error and must not be reused.
       *
       * Stripe keeps the identifier for ever and answers with a tombstone;
       * charging against it fails much later, in a place that does not say why.
       */
      if (!existing.deleted) {
        return { externalId: existing.id, email: existing.email };
      }
    }

    const created = await this.stripe.customers.create({ email, name });
    return { externalId: created.id, email: created.email };
  }

  async checkout(request: CheckoutRequest): Promise<HostedSession> {
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: request.mode,
        customer: request.customer,
        line_items: [{ price: request.price, quantity: request.quantity ?? 1 }],
        success_url: request.successUrl,
        cancel_url: request.cancelUrl,
        /*
         * Carried through so a webhook can be matched back without a lookup
         * table of our own — and on the subscription too, because the
         * session's metadata does not survive onto what it creates.
         */
        metadata: { subject: request.subject },
        ...(request.mode === 'subscription'
          ? {
              subscription_data: {
                metadata: { subject: request.subject },
                ...(request.trialDays ? { trial_period_days: request.trialDays } : {}),
              },
            }
          : {}),
        /*
         * VAT worked out by the provider, for the same reason the card is.
         * Both markets tax a digital subscription by where the customer is, and
         * a rate table maintained by hand is one that is wrong from the first
         * budget the finance ministry passes.
         */
        automatic_tax: { enabled: true },
        customer_update: { address: 'auto' },
      },
      { idempotencyKey: request.reference },
    );

    return { url: session.url ?? '', externalId: session.id };
  }

  async portal(customer: string, returnUrl: string): Promise<HostedSession> {
    const session = await this.stripe.billingPortal.sessions.create({
      customer,
      return_url: returnUrl,
    });

    return { url: session.url, externalId: session.id };
  }

  async subscription(externalId: string): Promise<ProviderSubscription | undefined> {
    try {
      return interpret(await this.stripe.subscriptions.retrieve(externalId));
    } catch {
      // Gone, or belonging to another environment sharing the account. Neither
      // is an error worth propagating to a screen.
      return undefined;
    }
  }

  async setQuantity(externalId: string, quantity: number): Promise<ProviderSubscription> {
    const current = await this.stripe.subscriptions.retrieve(externalId);
    const item = current.items.data[0];

    if (!item) throw new Error(`Subscription ${externalId} has nothing to change.`);

    const updated = await this.stripe.subscriptions.update(externalId, {
      items: [{ id: item.id, quantity }],
      /*
       * Charged for the part of the period actually used, on the next invoice.
       *
       * A salon that hires somebody on the twentieth pays for eleven days, not
       * a month — and pays it with everything else rather than as a separate
       * card charge nobody was expecting.
       */
      proration_behavior: 'create_prorations',
    });

    return interpret(updated);
  }

  async reportUsage(input: {
    customer: string;
    meter: string;
    quantity: number;
    at: Date;
    reference: string;
  }): Promise<void> {
    await this.stripe.billing.meterEvents.create({
      event_name: input.meter,
      payload: {
        stripe_customer_id: input.customer,
        value: String(Math.max(0, Math.round(input.quantity))),
      },
      /*
       * The provider's own de-duplication, over a rolling day.
       *
       * A nightly aggregation that runs twice — a retry, a redeploy mid-job —
       * would otherwise bill a venue for its tickets twice, and the customer
       * finds it before we do.
       */
      identifier: input.reference,
      timestamp: Math.floor(input.at.getTime() / 1000),
    });
  }

  async cancel(externalId: string, immediately: boolean): Promise<ProviderSubscription> {
    if (immediately) {
      return interpret(await this.stripe.subscriptions.cancel(externalId));
    }

    /*
     * At the end of what they have paid for, by default.
     *
     * Somebody cancelling in the first week has paid for the month, and taking
     * the product away that afternoon is how a cancellation becomes a refund
     * request and a review.
     */
    return interpret(
      await this.stripe.subscriptions.update(externalId, { cancel_at_period_end: true }),
    );
  }

  verify(payload: string | Buffer, signature: string | undefined): BillingEvent | undefined {
    if (!signature || !this.options.webhookSecret) return undefined;

    let event: Stripe.Event;

    try {
      event = this.stripe.webhooks.constructEvent(payload, signature, this.options.webhookSecret);
    } catch {
      // Not from the provider. The caller answers flatly rather than
      // describing what was wrong with the forgery.
      return undefined;
    }

    return interpretEvent(event);
  }
}

function interpret(subscription: Stripe.Subscription): ProviderSubscription {
  /*
   * `incomplete` reads as active here, and that is deliberate.
   *
   * It means the first payment is being authenticated — a 3-D Secure challenge
   * the customer is in the middle of — and treating it as unpaid switches the
   * product off in the thirty seconds between paying and the bank answering.
   */
  const status: ProviderSubscription['status'] =
    subscription.status === 'trialing'
      ? 'trialing'
      : subscription.status === 'past_due' || subscription.status === 'unpaid'
        ? 'past_due'
        : subscription.status === 'paused'
          ? 'paused'
          : subscription.status === 'canceled' || subscription.status === 'incomplete_expired'
            ? 'cancelled'
            : 'active';

  const item = subscription.items.data[0];

  return {
    externalId: subscription.id,
    status,
    quantity: item?.quantity ?? 1,
    // The period lives on the item in the current API rather than on the
    // subscription, which is where it used to be.
    currentPeriodEnd: new Date((item?.current_period_end ?? 0) * 1000),
    cancelAt: subscription.cancel_at ? new Date(subscription.cancel_at * 1000) : null,
  };
}

function interpretEvent(event: Stripe.Event): BillingEvent {
  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subscription = event.data.object as Stripe.Subscription;
      const read = interpret(subscription);

      return {
        kind: 'subscription',
        externalId: read.externalId,
        subscription: read,
        ...(customerOf(subscription.customer)
          ? { customer: customerOf(subscription.customer)! }
          : {}),
        ...(subscription.metadata?.subject ? { subject: subscription.metadata.subject } : {}),
      };
    }

    case 'invoice.paid':
    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;

      /*
       * The subscription's metadata, snapshotted onto the invoice.
       *
       * This is where our `tenant:<id>` subject survives to, and it is the only
       * thing that makes an invoice event attributable: the invoice's own
       * identifier is one we have never seen, and the table that could
       * translate the customer into a tenant is under `FORCE ROW LEVEL
       * SECURITY` — so a lookup with no tenant bound returns *no rows* rather
       * than an error, and the event changes nothing while appearing handled.
       */
      const details = (invoice as { subscription_details?: { metadata?: Stripe.Metadata | null } })
        .subscription_details;

      return {
        kind: 'invoice',
        externalId: invoice.id ?? '',
        ...(details?.metadata?.subject ? { subject: details.metadata.subject } : {}),
        ...(customerOf(invoice.customer) ? { customer: customerOf(invoice.customer)! } : {}),
        paid: event.type === 'invoice.paid',
        amount: invoice.amount_due,
        currency: invoice.currency.toUpperCase(),
        ...(invoice.hosted_invoice_url ? { invoiceUrl: invoice.hosted_invoice_url } : {}),
      };
    }

    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;

      return {
        kind: 'checkout',
        externalId: session.id,
        ...(customerOf(session.customer) ? { customer: customerOf(session.customer)! } : {}),
        ...(session.metadata?.subject ? { subject: session.metadata.subject } : {}),
        paid: session.payment_status === 'paid',
        ...(session.amount_total === null ? {} : { amount: session.amount_total }),
        ...(session.currency ? { currency: session.currency.toUpperCase() } : {}),
      };
    }

    default:
      /*
       * Stripe sends a great many event types and a deployment's subscription
       * drifts. Treating an unknown one as an error means retries and an alert
       * for something that was never any of our business.
       */
      return { kind: 'other', externalId: event.id };
  }
}

/**
 * The customer's identifier, however the vendor chose to send it.
 *
 * Expanded objects and bare strings both appear on the same field depending on
 * the event and the API version, and a reader that assumes one of them silently
 * finds nothing on half the traffic.
 */
function customerOf(customer: unknown): string | undefined {
  if (typeof customer === 'string') return customer;
  if (customer && typeof customer === 'object' && 'id' in customer) {
    return String((customer as { id: unknown }).id);
  }
  return undefined;
}
