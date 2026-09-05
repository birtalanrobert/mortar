import { Inject, Injectable } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { InjectDataSource } from '@birtalanrobert/database';
import { runInTenantTransaction } from '@birtalanrobert/tenancy';
import { getActor } from '@birtalanrobert/context';
import { ConflictError, NotFoundError, ValidationError } from '@birtalanrobert/http';
import { canTakeMoney, type PayoutStatus } from '../deposits';
import type { PaymentProvider, ProviderEvent } from '../providers/port';
import { PayoutAccount } from './payout-account.entity';
import { isRefundable, type PaymentKind } from '../payments';
import { Payment, PaymentRefund, type PaymentMethod } from './payment.entity';
import { SavedCard } from './saved-card.entity';

/** The provider this deployment uses, injected so tests can supply their own. */
export const COMMERCE_PROVIDER = Symbol('COMMERCE_PROVIDER');

export interface TakePayment {
  readonly subject: string;
  readonly amount: number;
  readonly currency: string;
  readonly applicationFee?: number;
  readonly description?: string;
  /** What it is for. `sale` unless said otherwise. */
  readonly kind?: PaymentKind;
  /**
   * A stored card to charge without anybody present.
   *
   * The whole reason for keeping one: a fee is decided days after the fact, and
   * the customer is not there to be asked.
   */
  readonly savedCardId?: string;
  /** False holds the money instead of taking it. See `capture`. */
  readonly capture?: boolean;
  /**
   * Makes the charge idempotent across retries of the same act.
   *
   * A person pressing a button twice on a slow connection is the ordinary case,
   * not an exotic one, and the second press must not produce a second charge.
   */
  readonly reference: string;
}

export interface RecordPayment {
  readonly subject: string;
  readonly amount: number;
  readonly currency: string;
  readonly method: Exclude<PaymentMethod, 'card'>;
  readonly kind?: PaymentKind;
  readonly detail?: string;
}

/**
 * A charge, and what the browser needs to finish it.
 *
 * The secret is returned rather than stored: a charge created on the server has
 * no card attached to it yet, and the card is entered against the provider's own
 * script so the number never reaches us. Without handing it back, a payment can
 * be created and never paid — which a customer reads as "it took my booking and
 * lost my money".
 */
export interface TakenPayment {
  readonly payment: Payment;
  readonly clientSecret?: string;
}

/** A card being stored, and what the browser confirms it with. */
export interface CardToSave {
  readonly subject: string;
  readonly reference: string;
  /** What the customer was told they were agreeing to, in their own language. */
  readonly consentText: string;
}

/**
 * Money between a customer and a business, and the record of it.
 *
 * **We never hold their funds** — the customer pays the business directly and
 * our fee is taken on top — so almost everything here is about the *record*
 * rather than the movement. That record has to be complete enough to produce a
 * business's own takings years later, after the provider account is closed.
 *
 * Every method runs inside the tenant's policy, reads included: these tables are
 * under row-level security, and an unbound read returns *nothing* rather than
 * failing — which here means a revenue report of zero for a business that took
 * money all month.
 */
@Injectable()
export class CommerceService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(COMMERCE_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  // ── Getting paid at all ──────────────────────────────────────────────────

  /** Where a business's money goes, and whether the provider will send it yet. */
  async payoutAccount(tenantId: string): Promise<PayoutAccount | null> {
    return runInTenantTransaction(
      this.dataSource,
      (scoped) =>
        scoped
          .getRepository(PayoutAccount)
          .findOne({ where: { tenantId, provider: this.provider.name } }),
      { tenantId },
    );
  }

  async payoutStatus(tenantId: string): Promise<PayoutStatus> {
    return (await this.payoutAccount(tenantId))?.status ?? 'none';
  }

  /**
   * Starts or resumes onboarding, creating the provider's account if needed.
   *
   * Called again as often as somebody presses the button: onboarding is a form
   * people abandon and come back to, and the link is short-lived, so "resume"
   * is the common case rather than the exception.
   */
  async startOnboarding(
    tenantId: string,
    options: { country: string; email?: string; returnUrl: string; refreshUrl: string },
  ): Promise<{ url: string; expiresAt: Date }> {
    const existing = await this.payoutAccount(tenantId);

    const account = await this.provider.account(
      existing?.externalId ?? null,
      options.country,
      options.email,
    );

    await this.saveAccount(tenantId, account);

    return this.provider.onboard(account.externalId, options.returnUrl, options.refreshUrl);
  }

  /** Asks the provider where onboarding stands, and records the answer. */
  async refreshPayoutAccount(tenantId: string): Promise<PayoutStatus> {
    const existing = await this.payoutAccount(tenantId);
    if (!existing) return 'none';

    const account = await this.provider.account(existing.externalId, 'RO');
    await this.saveAccount(tenantId, account);

    return account.status;
  }

  // ── Taking money ─────────────────────────────────────────────────────────

  /**
   * Charges a card, or holds one.
   *
   * Refused before the provider is called if the business cannot be paid out:
   * a charge that succeeds into an account with no destination leaves the
   * customer debited and the money nowhere anybody can see it, and the first
   * the business hears is asking where it went.
   */
  async take(tenantId: string, input: TakePayment): Promise<TakenPayment> {
    const account = await this.payoutAccount(tenantId);

    if (!account || !canTakeMoney(account.status)) {
      throw new ConflictError('This business cannot take card payments yet.');
    }

    const saved = input.savedCardId ? await this.savedCard(tenantId, input.savedCardId) : null;

    if (input.savedCardId && !saved) {
      throw new NotFoundError('SavedCard', input.savedCardId);
    }

    if (input.amount <= 0) {
      throw new ValidationError(
        [{ field: 'amount', message: 'There is nothing to charge.' }],
        'There is nothing to charge.',
      );
    }

    const result = await this.provider.charge({
      account: account.externalId,
      amount: input.amount,
      currency: input.currency,
      applicationFee: input.applicationFee ?? 0,
      subject: input.subject,
      capture: input.capture ?? true,
      ...(input.description ? { description: input.description } : {}),
      ...(saved ? { customer: saved.customerRef, paymentMethod: saved.paymentMethodRef } : {}),
      reference: input.reference,
    });

    const payment = await runInTenantTransaction(
      this.dataSource,
      async (scoped) => {
        const repository = scoped.getRepository(Payment);

        return repository.save(
          repository.create({
            tenantId,
            subject: input.subject,
            method: 'card',
            kind: input.kind ?? 'sale',
            state: result.state,
            amount: String(input.amount),
            currency: input.currency,
            applicationFee: String(input.applicationFee ?? 0),
            refunded: '0',
            provider: this.provider.name,
            externalId: result.externalId || null,
            instrument: result.instrument ?? null,
            // Only when the money actually moved. A hold has not moved it, and
            // a report that counted holds would overstate a business's takings.
            takenAt: result.state === 'captured' ? new Date() : null,
            detail: result.detail ?? null,
            recordedBy: getActor()?.id ?? null,
          }),
        );
      },
      { tenantId },
    );

    /*
     * The secret is handed back and never written down.
     *
     * It authorises whoever holds it to pay this one charge, so it belongs in
     * the response to the person paying and nowhere else — not in a column, not
     * in a log line, and not in an error.
     */
    return { payment, ...(result.clientSecret ? { clientSecret: result.clientSecret } : {}) };
  }

  /**
   * Starts storing a card without charging it, and records what was agreed.
   *
   * Two steps, because there is a browser in the middle: this creates the
   * intent and hands back a secret, and `confirmCard` writes the row once the
   * provider says a card really is stored. Believing the browser instead would
   * mean a business holding a card reference that charges nothing.
   */
  async saveCard(
    tenantId: string,
    input: CardToSave,
  ): Promise<{ externalId: string; clientSecret: string }> {
    const existing = await this.savedCards(tenantId, input.subject);

    const result = await this.provider.saveCard({
      subject: input.subject,
      reference: input.reference,
      // Reuse the customer this person already has, so a second card joins the
      // first rather than creating a stranger with the same name.
      ...(existing[0] ? { customer: existing[0].customerRef } : {}),
    });

    return { externalId: result.externalId, clientSecret: result.clientSecret };
  }

  /**
   * Writes down the card the provider says is now stored.
   *
   * Read back from the provider rather than taken from the browser: what a page
   * reports is what a page was told to report, and this row is what a business
   * will later charge real money against.
   */
  async confirmCard(
    tenantId: string,
    externalId: string,
    input: CardToSave,
  ): Promise<SavedCard | null> {
    const stored = await this.provider.storedCard(externalId);
    if (!stored) return null;

    return runInTenantTransaction(
      this.dataSource,
      async (scoped) => {
        const repository = scoped.getRepository(SavedCard);

        const already = await repository.findOne({
          where: { tenantId, paymentMethodRef: stored.paymentMethod },
        });

        // Confirming twice is the ordinary case on a slow connection, not an
        // exotic one, and it must not leave two rows for one card.
        if (already) return already;

        return repository.save(
          repository.create({
            tenantId,
            subject: input.subject,
            provider: this.provider.name,
            customerRef: stored.customer,
            paymentMethodRef: stored.paymentMethod,
            brand: stored.brand ?? null,
            last4: stored.last4 ?? null,
            expiryMonth: stored.expiryMonth ?? null,
            expiryYear: stored.expiryYear ?? null,
            consentText: input.consentText,
            consentedAt: new Date(),
            storedBy: getActor()?.id ?? null,
          }),
        );
      },
      { tenantId },
    );
  }

  /** Every card kept for somebody, newest first. */
  async savedCards(tenantId: string, subject: string): Promise<SavedCard[]> {
    return runInTenantTransaction(
      this.dataSource,
      (scoped) =>
        scoped
          .getRepository(SavedCard)
          .find({ where: { tenantId, subject }, order: { createdAt: 'DESC' } }),
      { tenantId },
    );
  }

  async savedCard(tenantId: string, id: string): Promise<SavedCard | null> {
    return runInTenantTransaction(
      this.dataSource,
      (scoped) => scoped.getRepository(SavedCard).findOne({ where: { tenantId, id } }),
      { tenantId },
    );
  }

  /**
   * Forgets a card, at the customer's request or the business's.
   *
   * The provider is told first. A row deleted while the provider still holds
   * the card is a card nobody can see and anybody with the reference can
   * charge; the reverse — a detached card with a row still here — is merely a
   * charge that fails.
   */
  async forgetCard(tenantId: string, id: string): Promise<void> {
    const card = await this.savedCard(tenantId, id);
    if (!card) return;

    await this.provider.forgetCard(card.paymentMethodRef);

    await runInTenantTransaction(
      this.dataSource,
      (scoped) => scoped.getRepository(SavedCard).delete({ tenantId, id }),
      { tenantId },
    );
  }

  /**
   * Writes down money that arrived some other way.
   *
   * Cash at the counter, a card terminal, a meal voucher, a bank transfer.
   * **Recording is not a lesser feature**: a salon is mostly cash, a restaurant
   * takes vouchers, a box office takes notes — and a report that counted only
   * what a provider processed would tell a business a fraction of its own
   * takings while looking complete.
   */
  async record(tenantId: string, input: RecordPayment): Promise<Payment> {
    if (input.amount <= 0) {
      throw new ValidationError(
        [{ field: 'amount', message: 'There is nothing to record.' }],
        'There is nothing to record.',
      );
    }

    return runInTenantTransaction(
      this.dataSource,
      async (scoped) => {
        const repository = scoped.getRepository(Payment);

        return repository.save(
          repository.create({
            tenantId,
            subject: input.subject,
            method: input.method,
            kind: input.kind ?? 'sale',
            // Captured immediately: the money is in the till. There is no
            // provider to wait for and nothing that can fail later.
            state: 'captured',
            amount: String(input.amount),
            currency: input.currency,
            applicationFee: '0',
            refunded: '0',
            provider: null,
            externalId: null,
            takenAt: new Date(),
            detail: input.detail ?? null,
            // Who wrote it down, because a cash payment has no other evidence.
            recordedBy: getActor()?.id ?? null,
          }),
        );
      },
      { tenantId },
    );
  }

  /**
   * Takes money that was only held.
   *
   * **The human decision has been made by the time this is called.** Charging a
   * no-show fee automatically is how a business loses that customer
   * permanently, so this package offers the mechanism and never the trigger.
   */
  async capture(tenantId: string, paymentId: string, amount?: number): Promise<Payment> {
    const payment = await this.find(tenantId, paymentId);

    if (payment.state !== 'authorized' || !payment.externalId) {
      throw new ConflictError('That payment is not being held.');
    }

    const result = await this.provider.capture(payment.externalId, amount);

    return this.update(tenantId, paymentId, {
      state: result.state,
      takenAt: result.state === 'captured' ? new Date() : null,
      ...(amount === undefined ? {} : { amount: String(amount) }),
      detail: result.detail ?? null,
    });
  }

  /** Lets a held card go without taking anything. */
  async release(tenantId: string, paymentId: string): Promise<Payment> {
    const payment = await this.find(tenantId, paymentId);

    if (payment.state !== 'authorized' || !payment.externalId) {
      throw new ConflictError('That payment is not being held.');
    }

    await this.provider.release(payment.externalId);

    return this.update(tenantId, paymentId, { state: 'cancelled' });
  }

  // ── Giving it back ───────────────────────────────────────────────────────

  /**
   * Refunds some or all of a payment, with a reason.
   *
   * The reason is required because "we refunded her ninety lei in March" is a
   * question somebody asks a year later, and a blank answer cannot be defended.
   */
  async refund(
    tenantId: string,
    paymentId: string,
    amount: number,
    reason: string,
  ): Promise<Payment> {
    const payment = await this.find(tenantId, paymentId);

    if (!isRefundable(payment.state)) {
      throw new ConflictError('That payment cannot be refunded.');
    }

    const already = Number(payment.refunded);
    const remaining = Number(payment.amount) - already;

    if (amount <= 0 || amount > remaining) {
      throw new ValidationError(
        [{ field: 'amount', message: `At most ${remaining} can be given back.` }],
        `At most ${remaining} can be given back.`,
      );
    }

    /*
     * The provider first, then the record.
     *
     * A row saying money was returned when it was not is worse than no row: it
     * is an answer to "did she get it back" that happens to be wrong, and the
     * customer is the one who finds out.
     */
    const external = payment.externalId
      ? await this.provider.refund({
          externalId: payment.externalId,
          amount,
          reason,
          reference: `${paymentId}-${already + amount}`,
        })
      : null;

    return runInTenantTransaction(
      this.dataSource,
      async (scoped) => {
        const refunds = scoped.getRepository(PaymentRefund);

        await refunds.save(
          refunds.create({
            tenantId,
            paymentId,
            amount: String(amount),
            reason,
            externalId: external?.externalId ?? null,
            refundedBy: getActor()?.id ?? null,
          }),
        );

        const total = already + amount;

        await scoped.getRepository(Payment).update(
          { id: paymentId, tenantId },
          {
            refunded: String(total),
            state: total >= Number(payment.amount) ? 'refunded' : 'partially_refunded',
          },
        );

        return scoped.getRepository(Payment).findOneOrFail({ where: { id: paymentId, tenantId } });
      },
      { tenantId },
    );
  }

  // ── Reading ──────────────────────────────────────────────────────────────

  /** Everything taken for one thing: a booking, an order, a tab. */
  async forSubject(tenantId: string, subject: string): Promise<Payment[]> {
    return runInTenantTransaction(
      this.dataSource,
      (scoped) =>
        scoped
          .getRepository(Payment)
          .find({ where: { tenantId, subject }, order: { createdAt: 'ASC' } }),
      { tenantId },
    );
  }

  /** What a payment has had given back, and why. */
  async refundsFor(tenantId: string, paymentId: string): Promise<PaymentRefund[]> {
    return runInTenantTransaction(
      this.dataSource,
      (scoped) =>
        scoped
          .getRepository(PaymentRefund)
          .find({ where: { tenantId, paymentId }, order: { createdAt: 'ASC' } }),
      { tenantId },
    );
  }

  // ── What the provider says afterwards ────────────────────────────────────

  /**
   * Records what a webhook said, whatever it was about.
   *
   * A payment the deployment has no record of is **ignored rather than
   * inserted**: it belongs to another environment sharing the provider account,
   * and inventing a row for it would put another system's money in this one's
   * books.
   */
  async settle(event: ProviderEvent): Promise<Payment | PayoutAccount | undefined> {
    if (event.kind === 'account' && event.accountStatus) {
      const rows = await this.dataSource.query<Array<{ tenant_id: string }>>(
        `SELECT "tenant_id" FROM "mortar_payout_accounts" WHERE "external_id" = $1`,
        [event.externalId],
      );

      const tenantId = rows[0]?.tenant_id;
      if (!tenantId) return undefined;

      await this.saveAccount(tenantId, event.accountStatus);
      return (await this.payoutAccount(tenantId)) ?? undefined;
    }

    if (event.kind !== 'payment' || !event.state) return undefined;

    /*
     * Found by the provider's identifier, which is the only thing both sides
     * share — and read without a tenant because a webhook does not carry one.
     * The row itself says whose it is.
     */
    const rows = await this.dataSource.query<Array<{ id: string; tenant_id: string }>>(
      `SELECT "id", "tenant_id" FROM "mortar_payments" WHERE "external_id" = $1`,
      [event.externalId],
    );

    const found = rows[0];
    if (!found) return undefined;

    const state = event.state === 'refunded' ? 'refunded' : event.state;

    return this.update(found.tenant_id, found.id, {
      state,
      ...(state === 'captured' ? { takenAt: new Date() } : {}),
      ...(event.instrument ? { instrument: event.instrument } : {}),
      ...(event.detail ? { detail: event.detail } : {}),
    });
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async find(tenantId: string, paymentId: string): Promise<Payment> {
    const payment = await runInTenantTransaction(
      this.dataSource,
      (scoped) => scoped.getRepository(Payment).findOne({ where: { id: paymentId, tenantId } }),
      { tenantId },
    );

    if (!payment) throw new NotFoundError('Payment', paymentId);
    return payment;
  }

  private async update(
    tenantId: string,
    paymentId: string,
    patch: Partial<Payment>,
    manager?: EntityManager,
  ): Promise<Payment> {
    const work = async (scoped: EntityManager): Promise<Payment> => {
      await scoped.getRepository(Payment).update({ id: paymentId, tenantId }, patch);
      return scoped.getRepository(Payment).findOneOrFail({ where: { id: paymentId, tenantId } });
    };

    return manager ? work(manager) : runInTenantTransaction(this.dataSource, work, { tenantId });
  }

  private async saveAccount(
    tenantId: string,
    account: { externalId: string; status: PayoutStatus; requirements: readonly string[] },
  ): Promise<void> {
    await runInTenantTransaction(
      this.dataSource,
      async (scoped) => {
        await scoped.query(
          `INSERT INTO "mortar_payout_accounts"
             ("tenant_id", "provider", "external_id", "status", "requirements", "ready_at")
           VALUES ($1, $2, $3, $4, $5::jsonb, $6)
           ON CONFLICT ("tenant_id", "provider")
           DO UPDATE SET "external_id" = EXCLUDED."external_id",
                         "status" = EXCLUDED."status",
                         "requirements" = EXCLUDED."requirements",
                         -- Set once and never cleared: the first time a
                         -- provider agreed to pay a business out is a date
                         -- worth keeping, and a later restriction does not
                         -- unmake it.
                         "ready_at" = COALESCE("mortar_payout_accounts"."ready_at", EXCLUDED."ready_at"),
                         "updated_at" = now()`,
          [
            tenantId,
            this.provider.name,
            account.externalId,
            account.status,
            JSON.stringify([...account.requirements]),
            account.status === 'ready' ? new Date() : null,
          ],
        );
      },
      { tenantId },
    );
  }
}
