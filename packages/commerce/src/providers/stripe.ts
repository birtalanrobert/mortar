import Stripe from 'stripe';
import type {
  ChargeRequest,
  ChargeResult,
  OnboardingLink,
  PaymentProvider,
  ProviderAccount,
  ProviderEvent,
  RefundRequest,
} from './port';

export interface StripeConnectOptions {
  secretKey: string;
  /** The endpoint's signing secret, as the dashboard gives it: `whsec_…`. */
  webhookSecret?: string;
  /** An already-built client, for tests and for a deployment that shares one. */
  client?: Stripe;
}

/**
 * Stripe Connect, as the port describes it.
 *
 * **Destination charges throughout.** The money is created on our platform
 * account and transferred immediately to the business, with our cut taken as an
 * application fee — which is what keeps this a software company rather than a
 * regulated one, and what lets the business see its own payouts in its own
 * Stripe dashboard.
 *
 * Everything the provider does *not* need to decide is decided before this file
 * is reached: what a deposit comes to, whether a business may sell, what a
 * refund leaves. What is here is the part that genuinely needs somebody else's
 * money-moving licence.
 */
export class StripeConnect implements PaymentProvider {
  readonly name = 'stripe';
  private readonly stripe: Stripe;

  constructor(private readonly options: StripeConnectOptions) {
    this.stripe = options.client ?? new Stripe(options.secretKey);
  }

  async account(
    externalId: string | null,
    country: string,
    email?: string,
  ): Promise<ProviderAccount> {
    const account = externalId
      ? await this.stripe.accounts.retrieve(externalId)
      : await this.stripe.accounts.create({
          type: 'express',
          country,
          ...(email ? { email } : {}),
          capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
        });

    return interpretAccount(account);
  }

  async onboard(
    externalId: string,
    returnUrl: string,
    refreshUrl: string,
  ): Promise<OnboardingLink> {
    const link = await this.stripe.accountLinks.create({
      account: externalId,
      type: 'account_onboarding',
      return_url: returnUrl,
      /*
       * Where the business lands if the link has aged out.
       *
       * Stripe's onboarding links are short-lived and somebody *will* open one
       * the next morning. Without this they meet an error page from a company
       * they have never heard of, halfway through giving it their passport.
       */
      refresh_url: refreshUrl,
    });

    return { url: link.url, expiresAt: new Date(link.expires_at * 1000) };
  }

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    try {
      const intent = await this.stripe.paymentIntents.create(
        {
          amount: request.amount,
          currency: request.currency.toLowerCase(),
          /*
           * The money lands on the business's account, not ours.
           *
           * `transfer_data.destination` with `application_fee_amount` is the
           * destination-charge shape: we never hold their funds, and their
           * payouts appear in their own dashboard.
           */
          transfer_data: { destination: request.account },
          ...(request.applicationFee > 0 ? { application_fee_amount: request.applicationFee } : {}),
          capture_method: request.capture ? 'automatic' : 'manual',
          ...(request.description ? { description: request.description } : {}),
          // Carried through so a webhook can be matched back to what it paid
          // for without a lookup table of our own.
          metadata: { subject: request.subject },
          automatic_payment_methods: { enabled: true },
        },
        // The provider's own idempotency, so a retried request — a timeout, a
        // double submit — does not charge somebody twice.
        { idempotencyKey: request.reference },
      );

      return interpretIntent(intent);
    } catch (error) {
      return failure(error);
    }
  }

  async capture(externalId: string, amount?: number): Promise<ChargeResult> {
    try {
      const intent = await this.stripe.paymentIntents.capture(
        externalId,
        amount === undefined ? undefined : { amount_to_capture: amount },
      );

      return interpretIntent(intent);
    } catch (error) {
      return failure(error);
    }
  }

  async release(externalId: string): Promise<void> {
    await this.stripe.paymentIntents.cancel(externalId);
  }

  async refund(request: RefundRequest): Promise<{ externalId: string }> {
    const refund = await this.stripe.refunds.create(
      {
        payment_intent: request.externalId,
        amount: request.amount,
        metadata: { reason: request.reason.slice(0, 500) },
      },
      { idempotencyKey: request.reference },
    );

    return { externalId: refund.id };
  }

  verify(payload: string | Buffer, signature: string | undefined): ProviderEvent | undefined {
    if (!signature || !this.options.webhookSecret) return undefined;

    let event: Stripe.Event;

    try {
      event = this.stripe.webhooks.constructEvent(payload, signature, this.options.webhookSecret);
    } catch {
      /*
       * A forgery, or a payload something re-encoded on the way in.
       *
       * `undefined` rather than a thrown error: the caller answers a request
       * that did not come from Stripe with a flat acknowledgement, not with a
       * message describing what was wrong with it.
       */
      return undefined;
    }

    return interpretEvent(event);
  }
}

/** Stripe's account shape, reduced to the question anybody actually asks. */
function interpretAccount(account: Stripe.Account): ProviderAccount {
  const requirements = [
    ...(account.requirements?.currently_due ?? []),
    ...(account.requirements?.past_due ?? []),
  ];

  /*
   * `charges_enabled` and `payouts_enabled` together, not either alone.
   *
   * A business that can take money but cannot be paid out is worse than one
   * that cannot sell yet: the customer is charged and the money sits with the
   * provider, and the first anybody hears is the business asking where it is.
   */
  const ready = account.charges_enabled === true && account.payouts_enabled === true;

  return {
    externalId: account.id,
    status: ready ? 'ready' : requirements.length > 0 ? 'restricted' : 'pending',
    requirements: [...new Set(requirements)],
  };
}

function interpretIntent(intent: Stripe.PaymentIntent): ChargeResult {
  const state =
    intent.status === 'succeeded'
      ? 'captured'
      : intent.status === 'requires_capture'
        ? 'authorized'
        : intent.status === 'canceled'
          ? 'failed'
          : 'pending';

  const charge = intent.latest_charge;
  const card =
    typeof charge === 'object' && charge?.payment_method_details?.card
      ? `${charge.payment_method_details.card.brand} ending ${charge.payment_method_details.card.last4}`
      : undefined;

  return {
    externalId: intent.id,
    state,
    ...(intent.next_action?.redirect_to_url?.url
      ? { redirectUrl: intent.next_action.redirect_to_url.url }
      : {}),
    ...(card ? { instrument: card } : {}),
    ...(intent.last_payment_error?.message ? { detail: intent.last_payment_error.message } : {}),
  };
}

function interpretEvent(event: Stripe.Event): ProviderEvent {
  switch (event.type) {
    case 'payment_intent.succeeded':
    case 'payment_intent.amount_capturable_updated':
    case 'payment_intent.payment_failed': {
      const intent = event.data.object as Stripe.PaymentIntent;
      const result = interpretIntent(intent);

      return {
        kind: 'payment',
        externalId: intent.id,
        state:
          event.type === 'payment_intent.payment_failed'
            ? 'failed'
            : result.state === 'captured'
              ? 'captured'
              : 'authorized',
        ...(result.instrument ? { instrument: result.instrument } : {}),
        ...(result.detail ? { detail: result.detail } : {}),
      };
    }

    case 'charge.refunded': {
      const charge = event.data.object as Stripe.Charge;
      return {
        kind: 'payment',
        externalId: typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.id,
        state: 'refunded',
      };
    }

    case 'account.updated': {
      const account = event.data.object as Stripe.Account;
      return { kind: 'account', externalId: account.id, accountStatus: interpretAccount(account) };
    }

    default:
      /*
       * Everything else is acknowledged and ignored.
       *
       * Stripe sends a great many event types and a deployment's subscription
       * will drift; treating an unknown one as an error means retries and an
       * alert for something that was never any of our business.
       */
      return { kind: 'other', externalId: event.id };
  }
}

/** A provider's refusal, as a result rather than an exception. */
function failure(error: unknown): ChargeResult {
  const message =
    error instanceof Stripe.errors.StripeError
      ? (error.message ?? 'The payment was refused.')
      : error instanceof Error
        ? error.message
        : 'The payment was refused.';

  return { externalId: '', state: 'failed', detail: message };
}
