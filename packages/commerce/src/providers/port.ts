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
  readonly instrument?: string;
  readonly detail?: string;
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
