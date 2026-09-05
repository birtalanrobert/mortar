import type {
  ChargeRequest,
  ChargeResult,
  OnboardingLink,
  PaymentProvider,
  ProviderAccount,
  RefundRequest,
  SaveCardRequest,
  SaveCardResult,
  StoredCard,
} from './port';

/**
 * No payment provider at all, said out loud rather than by failing.
 *
 * **Online payment is optional and never mandatory**, and this is what makes
 * that true in the code rather than only in a document. A salon that takes cash
 * at the counter and has never heard of Stripe runs its whole diary, writes
 * down what it took, and reports on it — and nothing about that deployment
 * should require a payment account to exist, least of all the application
 * starting up.
 *
 * The alternative that looks simpler is constructing the vendor's client with
 * an empty key. It throws inside its own constructor, and the whole API fails
 * to boot — which is how this was found.
 *
 * **Not a permissive no-op.** Every operation refuses, and the account reports
 * `none`, so every gate that already asks "can this business be paid out?"
 * answers no without a special case. A provider that quietly returned success
 * would write a trail of payments that never happened, which is worse than the
 * crash it replaced.
 */
export class NoPayments implements PaymentProvider {
  readonly name = 'none';

  async onboard(): Promise<OnboardingLink> {
    throw new Error('This deployment has no payment provider configured.');
  }

  /**
   * `none` rather than `pending`.
   *
   * They are different facts: `pending` means the provider is still checking,
   * and a business told that will wait for an email that is never coming.
   */
  async account(externalId: string | null): Promise<ProviderAccount> {
    return { externalId: externalId ?? '', status: 'none', requirements: [] };
  }

  async charge(_request: ChargeRequest): Promise<ChargeResult> {
    return {
      externalId: '',
      state: 'failed',
      detail: 'This business cannot take card payments.',
    };
  }

  async capture(): Promise<ChargeResult> {
    return { externalId: '', state: 'failed', detail: 'There is nothing to capture.' };
  }

  async release(): Promise<void> {
    // Nothing was ever held.
  }

  async refund(_request: RefundRequest): Promise<{ externalId: string }> {
    throw new Error('Nothing was taken through a provider, so nothing can be given back.');
  }

  async saveCard(_request: SaveCardRequest): Promise<SaveCardResult> {
    throw new Error('This deployment has no payment provider configured.');
  }

  async storedCard(): Promise<StoredCard | undefined> {
    return undefined;
  }

  async forgetCard(): Promise<void> {
    // There is nothing stored anywhere to forget.
  }

  /**
   * Never genuine.
   *
   * A deployment with no provider has no webhook to receive, so anything
   * arriving at that address came from somebody else — and `undefined` is how
   * the port says "not from the provider".
   */
  verify(): undefined {
    return undefined;
  }
}
