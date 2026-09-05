/**
 * What a payment provider has to be able to do, and nothing more.
 *
 * A port rather than the vendor's client, for the reason `@birtalanrobert/files`
 * has one over S3: the day a market needs a local processor — and one will,
 * because a restaurant that can be onboarded this afternoon beats a lower fee —
 * nothing above this interface moves.
 *
 * Deliberately small. Everything that can be decided without the provider is
 * decided without it: what a deposit comes to, whether a business may sell yet,
 * what a refund leaves. This is only the part that genuinely needs somebody
 * else's money-moving licence.
 */

/** Where a business's money goes, as the provider knows it. */
export interface ProviderAccount {
  readonly externalId: string;
  readonly status: 'pending' | 'restricted' | 'ready';
  /** What the provider still wants, in its own words. */
  readonly requirements: readonly string[];
}

export interface OnboardingLink {
  readonly url: string;
  readonly expiresAt: Date;
}

export interface ChargeRequest {
  /** The business being paid, as the provider knows it. */
  readonly account: string;
  /**
   * The customer, where one is being charged again rather than for the first
   * time. Held on *our* account rather than the business's, because that is
   * where a saved card lives under a destination charge.
   */
  readonly customer?: string;
  /**
   * A card already saved, to charge without anybody present.
   *
   * The whole point of storing one: a no-show fee is decided days later, and
   * asking somebody who did not turn up to enter a card is a conversation that
   * does not happen.
   */
  readonly paymentMethod?: string;
  readonly amount: number;
  readonly currency: string;
  /** Our cut, taken on top rather than out of the business's money. */
  readonly applicationFee: number;
  /** What it is for, carried through so a webhook can be matched back. */
  readonly subject: string;
  /**
   * Whether to take the money now or only hold it.
   *
   * Holding is the anti-no-show mechanism: a card is authorised and charged
   * only if a fee is actually applied, and **that decision is a human one**.
   */
  readonly capture: boolean;
  readonly description?: string;
  /** An idempotency key, so a retried request does not charge twice. */
  readonly reference: string;
}

export interface ChargeResult {
  readonly externalId: string;
  readonly state: 'pending' | 'authorized' | 'captured' | 'failed';
  /**
   * Where to send the customer to finish, when the provider needs them.
   *
   * 3-D Secure and bank redirects are the ordinary case in both target
   * markets rather than an exception, so a charge that returns a URL is not a
   * failure and must not be handled as one.
   */
  readonly redirectUrl?: string;
  /**
   * What the browser needs to finish paying, when the customer is present.
   *
   * A charge created on the server has no card attached to it yet — the card is
   * entered in a browser, against the provider's own script, so that the number
   * never reaches us. Without this the payment can be created and never paid,
   * which is the state a customer reads as "it took my booking and lost my
   * money".
   */
  readonly clientSecret?: string;
  readonly instrument?: string;
  readonly detail?: string;
}

/** A card being stored for later, rather than charged now. */
export interface SaveCardRequest {
  /** An existing customer to attach it to, where the person already has one. */
  readonly customer?: string;
  /** What it is being saved for, carried through for matching a webhook back. */
  readonly subject: string;
  readonly reference: string;
}

export interface SaveCardResult {
  /** The customer the card will hang off, created here if there was none. */
  readonly customer: string;
  /** The provider's handle on this attempt, to read the result back from. */
  readonly externalId: string;
  /** What the browser confirms against. */
  readonly clientSecret: string;
}

/** A card that was actually stored, read back after the browser confirmed it. */
export interface StoredCard {
  readonly customer: string;
  readonly paymentMethod: string;
  readonly brand?: string;
  readonly last4?: string;
  readonly expiryMonth?: number;
  readonly expiryYear?: number;
}

export interface RefundRequest {
  readonly externalId: string;
  readonly amount: number;
  readonly reason: string;
  readonly reference: string;
}

/** What a provider's webhook turned out to be about. */
export interface ProviderEvent {
  readonly kind: 'payment' | 'account' | 'other';
  readonly externalId: string;
  readonly state?: 'authorized' | 'captured' | 'failed' | 'refunded';
  readonly accountStatus?: ProviderAccount;
  readonly instrument?: string;
  readonly detail?: string;
}

export interface PaymentProvider {
  readonly name: string;

  /** Starts or resumes onboarding, and says where to send the business. */
  onboard(tenantId: string, returnUrl: string, refreshUrl: string): Promise<OnboardingLink>;

  /** Creates the account if there is none, and reports where it stands. */
  account(externalId: string | null, country: string, email?: string): Promise<ProviderAccount>;

  charge(request: ChargeRequest): Promise<ChargeResult>;

  /** Takes money that was only held. The human decision has been made. */
  capture(externalId: string, amount?: number): Promise<ChargeResult>;

  /** Releases a hold without taking anything. */
  release(externalId: string): Promise<void>;

  /**
   * Starts storing a card without charging it.
   *
   * The strongest thing a business can do about no-shows short of taking money:
   * nothing leaves the customer's account, and the card is there if a fee is
   * later decided on. A hold is not a substitute — providers expire one within
   * days, and an appointment is usually further away than that.
   */
  saveCard(request: SaveCardRequest): Promise<SaveCardResult>;

  /**
   * What was actually stored, once the browser says it finished.
   *
   * Read back from the provider rather than believed from the browser: what a
   * page reports is what a page was told to report, and a saved card is
   * something a business will later charge money against.
   */
  storedCard(externalId: string): Promise<StoredCard | undefined>;

  /** Forgets a stored card, at the customer's request or the business's. */
  forgetCard(paymentMethod: string): Promise<void>;

  refund(request: RefundRequest): Promise<{ externalId: string }>;

  /**
   * Whether a webhook really came from the provider, and what it says.
   *
   * `undefined` rather than a thrown error: the caller's answer to a request
   * that did not come from the provider is a flat acknowledgement, not a
   * message describing what was wrong with the forgery.
   */
  verify(payload: string | Buffer, signature: string | undefined): ProviderEvent | undefined;
}
