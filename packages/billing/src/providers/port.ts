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

/**
 * A single payment's price given by its amount rather than by an identifier
 * the provider keeps.
 *
 * For a product that sells packs whose prices an operator changes from its
 * own settings: a price created in the provider's dashboard and named by its
 * identifier is a second copy of the figure the product shows, and the two
 * drift the first time somebody edits one of them. Given here, the amount
 * charged is the amount shown, by construction.
 */
export interface InlinePrice {
  /** In the currency's minor units: 499 for €4.99. */
  readonly amount: number;
  /** ISO 4217, in either case. */
  readonly currency: string;
  /** What the buyer reads on the payment page and on the provider's records. */
  readonly name: string;
  /**
   * Whether `amount` already holds the tax the provider works out. A price
   * shown to a consumer in the EU does: what they see is what they pay.
   */
  readonly taxBehavior: 'inclusive' | 'exclusive';
  /** The provider's tax category for what is sold; absent, the account's default. */
  readonly taxCode?: string;
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
  /**
   * The provider's own price identifier for what is being bought — or, for a
   * single payment only, the price itself (`InlinePrice`).
   */
  readonly price: string | InlinePrice;
  readonly quantity?: number;
  readonly trialDays?: number;
  readonly successUrl: string;
  readonly cancelUrl: string;
  /** Carried through so a webhook can be matched back without a lookup table. */
  readonly subject: string;
  readonly reference: string;
  /**
   * More of the caller's own, carried through as `subject` is — onto the
   * session and, for a single payment, onto the payment itself, because an
   * event about a refund or a dispute names the payment and never the session.
   */
  readonly metadata?: Readonly<Record<string, string>>;
  /** The payment page's language, as the provider names it (`en`, `ro`, `hu`); absent, the buyer's browser's. */
  readonly locale?: string;
}

/**
 * A single payment taken in the product's own page — the provider's payment
 * form mounted there, such as Stripe's Payment Element — and confirmed from the
 * server, where the amount is decided.
 *
 * For a product whose buyers should not be sent to another site to pay. The
 * tax is still the provider's to work out, from where the buyer said they are
 * in that form: `pay` calculates it, attaches the calculation to the payment,
 * and the provider records the tax transaction when the payment succeeds and
 * reverses it when it is refunded.
 */
export interface PaymentRequest {
  readonly customer: string;
  /** What is charged, by its amount — the tax inside it or on top, as `taxBehavior` says. */
  readonly price: InlinePrice;
  /**
   * The provider's token for what the buyer gave in the form: how they pay,
   * and the billing address the tax is worked out from — Stripe's
   * ConfirmationToken, created in the page.
   */
  readonly confirmationToken: string;
  /**
   * Holds the payment to once: the same reference asked again — a retry after
   * a timeout — is answered with the payment already made, never a second one.
   */
  readonly reference: string;
  /** The caller's own, carried onto the payment, which a refund or a dispute will name. */
  readonly metadata?: Readonly<Record<string, string>>;
}

/** Why the provider refused a payment, in its own codes, for the page to say. */
export interface PaymentFailure {
  /** The provider's error code: `card_declined`, `expired_card`, `incorrect_cvc`… */
  readonly code: string;
  /** The issuer's reason, for a card it declined: `insufficient_funds`, `lost_card`… */
  readonly declineCode?: string;
  /** The provider's own sentence, in English. */
  readonly message: string;
}

/** A single payment, as the provider has it. */
export interface ProviderPayment {
  readonly externalId: string;
  /**
   * `succeeded` once the money is taken; `processing` while a slow method
   * clears; `requires_action` while the buyer must still do something in the
   * page — a 3-D Secure check — which `clientSecret` lets the page finish;
   * `failed` when it was refused, `failure` saying why, the buyer free to try
   * again; `canceled` when it never will be taken.
   */
  readonly status: 'succeeded' | 'processing' | 'requires_action' | 'failed' | 'canceled';
  /** In the currency's minor units: what is charged, the tax inside it or on top. */
  readonly amount: number;
  /** ISO 4217, upper case. */
  readonly currency: string;
  /**
   * The tax the provider worked out for the payment — inside `amount` for an
   * inclusive price — for one `pay` took, whether answered by it or read
   * back; absent for one it did not take.
   */
  readonly tax?: number;
  /** Handed to the page, to finish what `requires_action` asks of the buyer there. */
  readonly clientSecret?: string;
  readonly failure?: PaymentFailure;
  /** What `PaymentRequest.metadata` carried. */
  readonly metadata: Readonly<Record<string, string>>;
}

/** A tax record reversed, as the provider keeps it: its own transaction. */
export interface ProviderTaxReversal {
  readonly externalId: string;
}

/** Money returned, as the provider has it. */
export interface ProviderRefund {
  readonly externalId: string;
  /**
   * `pending` until the payment method confirms — a card refund usually at
   * once, a bank transfer in days — and `failed` when it never will.
   */
  readonly status: 'pending' | 'succeeded' | 'failed';
  /** In the currency's minor units. */
  readonly amount: number;
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
  readonly kind:
    'subscription' | 'invoice' | 'checkout' | 'payment' | 'refund' | 'dispute' | 'other';
  /**
   * The event's own identifier: the same on every delivery of it, which is
   * what makes a webhook delivered twice recognisable as one.
   */
  readonly eventId: string;
  /** What the event is about — a subscription, an invoice, a session, a charge, a dispute. */
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
  /**
   * Set on an invoice, a checkout or a payment event: whether the money
   * arrived. A checkout completed, or a payment confirmed, with the money still
   * clearing — a bank debit, a voucher — is not paid; its own event says so
   * when it is.
   */
  readonly paid?: boolean;
  /**
   * Set on a payment event: `true` when the payment was refused or given up,
   * and nothing was taken — the buyer may try again with another payment.
   */
  readonly failed?: boolean;
  /**
   * What an invoice came to, what a checkout charged, what a refunded payment
   * was for, or what a dispute questions — in minor units.
   */
  readonly amount?: number;
  readonly currency?: string;
  readonly invoiceUrl?: string;
  readonly subject?: string;
  /** What `CheckoutRequest.metadata` carried, as the event brought it back. */
  readonly metadata?: Readonly<Record<string, string>>;
  /** The single payment a checkout made or an event is about, a refund returned money from or a dispute questions. */
  readonly payment?: string;
  /** Set on a checkout event, and a payment event for one `pay` took: the tax within `amount`, as the provider worked it out. */
  readonly tax?: number;
  /**
   * Set on a refund event: how much of the payment has been returned so far,
   * every refund of it together — a refund made in the provider's own
   * dashboard as much as one asked for here.
   */
  readonly amountRefunded?: number;
  /**
   * Set on a dispute event: `true` when the disputed money has left the
   * account, `false` when it has come back because the dispute was won. An
   * inquiry that moves no money raises neither.
   */
  readonly fundsWithdrawn?: boolean;
}

export interface BillingProvider {
  readonly name: string;

  /** Finds or creates the customer this business is billed as. */
  customer(externalId: string | null, email: string, name: string): Promise<ProviderCustomer>;

  /**
   * Deletes a customer, for a person's erasure: the provider forgets who they
   * were — the address and the name it was given — and keeps the payments they
   * made, which accounting law holds it to.
   *
   * One already deleted, or one the provider never had, is not an error: the
   * answer to "forget this person" is the same either way, and an erasure
   * retried after a timeout must not fail on its own first attempt.
   */
  deleteCustomer(externalId: string): Promise<void>;

  /** A hosted page to start a subscription or take a single payment. */
  checkout(request: CheckoutRequest): Promise<HostedSession>;

  /**
   * Takes a single payment the buyer gave in the product's own page, confirmed
   * here with its tax worked out from where they are (`PaymentRequest`).
   *
   * A payment the provider refuses — a card declined — is answered as
   * `failed`, not thrown: it is an outcome for the page to say. An address the
   * provider cannot place for its tax is thrown as `PaymentLocationError`,
   * before anything is charged; anything else is thrown.
   */
  pay(request: PaymentRequest): Promise<ProviderPayment>;

  /**
   * A single payment as the provider has it now, asked rather than
   * remembered — when the buyer's page says it is done, before a webhook has
   * said so. Undefined for one the provider does not have.
   */
  payment(externalId: string): Promise<ProviderPayment | undefined>;

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
   * Returns a single payment's money — all of it, or `amount` of it — to the
   * way it was paid.
   *
   * Idempotent on `reference`: a refund asked for again after a timeout must
   * return the money once, and answer with the refund already made.
   */
  refund(input: {
    readonly payment: string;
    readonly amount?: number;
    readonly reference: string;
  }): Promise<ProviderRefund>;

  /**
   * Reverses `amount` — tax included — of the tax a payment taken by `pay`
   * recorded, for money gone back where the provider reverses nothing by
   * itself: a dispute that withdrew it. A refund needs none: the provider
   * reverses its tax as it refunds.
   *
   * Undefined when the payment recorded no tax to reverse — none was
   * attached, or none committed. Idempotent on `reference`.
   */
  reverseTax(input: {
    readonly payment: string;
    readonly amount: number;
    readonly reference: string;
  }): Promise<ProviderTaxReversal | undefined>;

  /**
   * Undoes a reversal `reverseTax` made — the money came back, a dispute
   * won — so the sale is recorded again. Idempotent on `reference`.
   */
  restoreTax(input: {
    readonly reversal: string;
    readonly reference: string;
  }): Promise<ProviderTaxReversal>;

  /**
   * Whether a webhook really came from the provider, and what it says.
   *
   * `undefined` rather than a thrown error: the answer to a request that did
   * not come from the provider is a flat acknowledgement, not a message
   * describing what was wrong with the forgery.
   */
  verify(payload: string | Buffer, signature: string | undefined): BillingEvent | undefined;
}
