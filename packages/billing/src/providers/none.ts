import type {
  BillingProvider,
  CheckoutRequest,
  HostedSession,
  ProviderCustomer,
  ProviderSubscription,
} from './port';

/**
 * No billing provider configured, said out loud rather than by failing.
 *
 * Every deployment starts this way and most development machines stay this way.
 * The lesson is `commerce`'s, learned the expensive way: constructing the
 * vendor's client with an empty key throws inside the vendor's own constructor
 * and the whole application fails to boot.
 *
 * **Not a permissive no-op.** Nothing here quietly succeeds — a subscription
 * that appears to exist and does not is worse than one that plainly cannot be
 * started, because the first is discovered by a customer who thinks they paid.
 */
export class NoBilling implements BillingProvider {
  readonly name = 'none';

  async customer(externalId: string | null, email: string): Promise<ProviderCustomer> {
    return { externalId: externalId ?? '', email };
  }

  async checkout(_request: CheckoutRequest): Promise<HostedSession> {
    throw new Error('This deployment has no billing provider configured.');
  }

  async portal(_customer: string): Promise<HostedSession> {
    throw new Error('This deployment has no billing provider configured.');
  }

  async subscription(): Promise<ProviderSubscription | undefined> {
    return undefined;
  }

  async setQuantity(): Promise<ProviderSubscription> {
    throw new Error('This deployment has no billing provider configured.');
  }

  async reportUsage(): Promise<void> {
    // Nothing to report it to. The product's own usage record still stands.
  }

  async cancel(): Promise<ProviderSubscription> {
    throw new Error('This deployment has no billing provider configured.');
  }

  /** A deployment with no provider has no webhook, so nothing arriving is ours. */
  verify(): undefined {
    return undefined;
  }
}
