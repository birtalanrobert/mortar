/**
 * What a billing provider has to be able to do, and nothing more.
 *
 * **This is us charging a business, on our own account.** Not to be confused
 * with `@birtalanrobert/commerce`, which is a business charging *its* customers
 * through Connect with the money never touching us. They share a vendor and
 * almost nothing else: different account, different liability, different answer
 * when one fails. Conflating them is the mistake that makes both hard to reason
 * about.
 *
 * Deliberately small, and deliberately **hosted**. Card collection, VAT
 * calculation, invoices, receipts, dunning emails and the "update my card"
 * screen are all things the provider already does to a standard we would not
 * match, in two markets whose invoice rules we would have to learn. What stays
 * ours is what a plan costs, what it permits, and what happens to the product
 * when nobody has paid.
 */

/** The business, as the provider knows it. Created on our own account. */
export interface ProviderCustomer {
  readonly externalId: string;
  readonly email: string | null;
}

/** Somewhere to send somebody to pay. */
export interface HostedSession {
  readonly url: string;
  readonly externalId: string;
}

export interface CheckoutRequest {
  readonly customer: string;
  /**
   * `subscription` for the recurring case, `payment` for a single purchase.
   *
   * Both are needed: one of the seventeen sells a wedding rather than a month,
   * and four sell a premium currency in packs.
   */
  readonly mode: 'subscription' | 'payment';
  /** The provider's own price identifier for the plan being bought. */
  readonly price: string;
  readonly quantity?: number;
  readonly trialDays?: number;
  readonly successUrl: string;
  readonly cancelUrl: string;
  /** Carried through so a webhook can be matched back without a lookup table. */
  readonly subject: string;
  readonly reference: string;
}

/** What the provider currently believes about a subscription. */
export interface ProviderSubscription {
  readonly externalId: string;
  readonly status: 'trialing' | 'active' | 'past_due' | 'paused' | 'cancelled';
  readonly quantity: number;
  readonly currentPeriodEnd: Date;
  /** Set once the customer has asked to stop at the end of what they paid for. */
  readonly cancelAt: Date | null;
}

/** What a provider's webhook turned out to be about. */
export interface BillingEvent {
  readonly kind: 'subscription' | 'invoice' | 'checkout' | 'other';
  readonly externalId: string;
  /**
   * The customer, where the event names one.
   *
   * The only handle an **invoice** event shares with anything we store: its own
   * identifier is the invoice's, which we have never seen. Without this, an
   * unpaid invoice can be verified, read and understood, and still not be
   * attributable to anybody — so nothing happens and the business runs unpaid
   * for ever.
   */
  readonly customer?: string;
  readonly subscription?: ProviderSubscription;
  /** Set on an invoice event: whether it was paid, and what it came to. */
  readonly paid?: boolean;
  readonly amount?: number;
  readonly currency?: string;
  readonly invoiceUrl?: string;
  readonly subject?: string;
}

export interface BillingProvider {
  readonly name: string;

  /** Finds or creates the customer this business is billed as. */
  customer(externalId: string | null, email: string, name: string): Promise<ProviderCustomer>;

  /** A hosted page to start a subscription or take a single payment. */
  checkout(request: CheckoutRequest): Promise<HostedSession>;

  /**
   * The provider's own account screen.
   *
   * Where a customer changes a card, downloads an invoice or cancels. Building
   * our own would mean rebuilding invoice rendering and card collection for two
   * tax jurisdictions, badly.
   */
  portal(customer: string, returnUrl: string): Promise<HostedSession>;

  /** What the provider currently says, asked rather than remembered. */
  subscription(externalId: string): Promise<ProviderSubscription | undefined>;

  /** Changes how many seats, units or employees are being paid for. */
  setQuantity(externalId: string, quantity: number): Promise<ProviderSubscription>;

  /**
   * Tells the provider what was used, so it appears on the invoice.
   *
   * Against the **customer** rather than a subscription line, because that is
   * what the current metering API is keyed by — and because a business with two
   * subscriptions still has one bill.
   *
   * Idempotent on `reference`: a nightly aggregation that runs twice must not
   * bill a venue for its tickets twice.
   */
  reportUsage(input: {
    readonly customer: string;
    readonly meter: string;
    readonly quantity: number;
    readonly at: Date;
    readonly reference: string;
  }): Promise<void>;

  /** Stops at the end of the paid period, or immediately. */
  cancel(externalId: string, immediately: boolean): Promise<ProviderSubscription>;

  /**
   * Whether a webhook really came from the provider, and what it says.
   *
   * `undefined` rather than a thrown error: the answer to a request that did
   * not come from the provider is a flat acknowledgement, not a message
   * describing what was wrong with the forgery.
   */
  verify(payload: string | Buffer, signature: string | undefined): BillingEvent | undefined;
}
