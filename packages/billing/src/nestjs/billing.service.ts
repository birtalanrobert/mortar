import { Inject, Injectable } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { InjectDataSource } from '@birtalanrobert/database';
import { runInTenantTransaction } from '@birtalanrobert/tenancy';
import { ConflictError, NotFoundError } from '@birtalanrobert/http';
import {
  dunningStage,
  isEntitled,
  type DunningStage,
  type SubscriptionStatus,
} from '../subscriptions';
import { hasFeature, withinLimit, type Plan } from '../plans';
import type { BillingEvent, BillingProvider } from '../providers/port';
import { BillingPlan } from './plan.entity';
import { Subscription } from './subscription.entity';

/** The provider this deployment uses, injected so tests can supply their own. */
export const BILLING_PROVIDER = Symbol('BILLING_PROVIDER');

/** Where a business stands, in the terms a product actually asks about. */
export interface Standing {
  readonly status: SubscriptionStatus;
  readonly plan: Plan | null;
  /** Whether the product should work at all. */
  readonly entitled: boolean;
  /** Whether *new* commitments may be made. */
  readonly canCommit: boolean;
  readonly dunning: DunningStage;
  readonly quantity: number;
  readonly currentPeriodEnd: Date | null;
  readonly trialEndsAt: Date | null;
  readonly cancelAt: Date | null;
}

/**
 * What a business pays us, and what that entitles it to.
 *
 * **The other direction from `@birtalanrobert/commerce`.** That is a business
 * charging its own customers with the money never touching us; this is us
 * charging the business on our own account. They share a vendor and almost
 * nothing else.
 *
 * Card collection, VAT, invoices and the "update my card" screen are the
 * provider's, deliberately. What is here is what a plan costs, what it permits,
 * and what the product does when nobody has paid — the three things no provider
 * knows anything about.
 */
@Injectable()
export class BillingService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
  ) {}

  // ── The price list ───────────────────────────────────────────────────────

  /** What is on the shelf, in the order it should be shown. */
  async plans(includeUnsellable = false): Promise<Plan[]> {
    const rows = await this.dataSource.getRepository(BillingPlan).find({
      ...(includeUnsellable ? {} : { where: { sellable: true } }),
      order: { sortOrder: 'ASC', basePrice: 'ASC' },
    });

    return rows.map(asPlan);
  }

  async plan(code: string): Promise<Plan | null> {
    const row = await this.dataSource.getRepository(BillingPlan).findOne({ where: { code } });
    return row ? asPlan(row) : null;
  }

  // ── Where a business stands ──────────────────────────────────────────────

  /**
   * Everything a product asks before letting somebody do something.
   *
   * One read rather than four, because it is asked on every request that
   * matters and the answers have to agree with each other. A business with no
   * subscription row at all is `none` — not an error, and not a crash: a
   * deployment that has never sold anything still runs.
   */
  async standingOf(tenantId: string): Promise<Standing> {
    const subscription = await this.subscriptionOf(tenantId);

    if (!subscription) {
      return {
        status: 'none',
        plan: null,
        entitled: false,
        canCommit: false,
        dunning: 'none',
        quantity: 0,
        currentPeriodEnd: null,
        trialEndsAt: null,
        cancelAt: null,
      };
    }

    const plan = await this.plan(subscription.planCode);

    const daysPastDue = subscription.pastDueSince
      ? Math.floor((Date.now() - subscription.pastDueSince.getTime()) / 86_400_000)
      : 0;

    /*
     * Suspension is a *dunning* outcome rather than a provider status.
     *
     * The provider says "past due" for ever; how long we tolerate it is our
     * commercial decision, and it belongs where the rest of that decision is.
     */
    const stage = dunningStage(daysPastDue);
    const suspended = stage === 'suspend';

    return {
      status: subscription.status,
      plan,
      entitled: isEntitled(subscription.status) && !suspended,
      canCommit: subscription.status === 'trialing' || subscription.status === 'active',
      dunning: stage,
      quantity: subscription.quantity,
      currentPeriodEnd: subscription.currentPeriodEnd,
      trialEndsAt: subscription.trialEndsAt,
      cancelAt: subscription.cancelAt,
    };
  }

  /** Whether this business's plan includes something. */
  async allows(tenantId: string, feature: string): Promise<boolean> {
    const { plan, entitled } = await this.standingOf(tenantId);
    return Boolean(entitled && plan && hasFeature(plan, feature));
  }

  /**
   * Whether one more is allowed, given how many there already are.
   *
   * Takes the count rather than computing it: what counts as a location or a
   * seat is the product's business and this package must not guess at a table
   * name.
   */
  async within(tenantId: string, key: string, used: number): Promise<boolean> {
    const { plan, entitled } = await this.standingOf(tenantId);
    return Boolean(entitled && plan && withinLimit(plan, key, used));
  }

  async subscriptionOf(tenantId: string): Promise<Subscription | null> {
    return runInTenantTransaction(
      this.dataSource,
      (scoped) => scoped.getRepository(Subscription).findOne({ where: { tenantId } }),
      { tenantId },
    );
  }

  // ── Selling ──────────────────────────────────────────────────────────────

  /**
   * Somewhere to send a business to start paying.
   *
   * The subscription row is written when the provider says the money moved, not
   * here. A row created on the way to a payment page is a subscription for
   * somebody who closed the tab.
   */
  async startCheckout(
    tenantId: string,
    input: {
      planCode: string;
      quantity: number;
      email: string;
      name: string;
      successUrl: string;
      cancelUrl: string;
    },
  ): Promise<string> {
    const plan = await this.plan(input.planCode);
    if (!plan) throw new NotFoundError('Plan', input.planCode);

    const row = await this.dataSource
      .getRepository(BillingPlan)
      .findOne({ where: { code: input.planCode } });

    if (!row?.externalPriceId) {
      throw new ConflictError('This plan cannot be bought yet.');
    }

    const existing = await this.subscriptionOf(tenantId);

    const customer = await this.provider.customer(
      existing?.customerRef ?? null,
      input.email,
      input.name,
    );

    await this.remember(tenantId, {
      planCode: input.planCode,
      customerRef: customer.externalId,
      quantity: input.quantity,
    });

    const session = await this.provider.checkout({
      customer: customer.externalId,
      mode: 'subscription',
      price: row.externalPriceId,
      quantity: Math.max(1, input.quantity),
      ...(plan.trialDays > 0 && !existing ? { trialDays: plan.trialDays } : {}),
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      subject: `tenant:${tenantId}`,
      reference: `checkout-${tenantId}-${input.planCode}`,
    });

    return session.url;
  }

  /** The provider's own account screen: cards, invoices, cancellation. */
  async portalLink(tenantId: string, returnUrl: string): Promise<string> {
    const subscription = await this.subscriptionOf(tenantId);

    if (!subscription?.customerRef) {
      throw new ConflictError('This business has nothing to manage yet.');
    }

    const session = await this.provider.portal(subscription.customerRef, returnUrl);
    return session.url;
  }

  /**
   * Changes how many seats, staff or units are being paid for.
   *
   * Called by the product when the thing it counts changes, and idempotent by
   * nature: setting the same number twice is one call to the provider and no
   * proration.
   */
  async setQuantity(tenantId: string, quantity: number): Promise<void> {
    const subscription = await this.subscriptionOf(tenantId);
    if (!subscription || subscription.quantity === quantity) return;

    if (subscription.externalId) {
      const updated = await this.provider.setQuantity(subscription.externalId, quantity);
      await this.remember(tenantId, { quantity: updated.quantity });
      return;
    }

    await this.remember(tenantId, { quantity });
  }

  /** Stops at the end of the paid period, or immediately. */
  async cancel(tenantId: string, immediately = false): Promise<void> {
    const subscription = await this.subscriptionOf(tenantId);
    if (!subscription?.externalId) throw new ConflictError('There is nothing to cancel.');

    const updated = await this.provider.cancel(subscription.externalId, immediately);

    await this.remember(tenantId, {
      status: updated.status,
      cancelAt: updated.cancelAt,
    });
  }

  // ── Metered usage ────────────────────────────────────────────────────────

  /**
   * Adds to what a tenant used today.
   *
   * Counted here on every use and reported to the provider in a batch, because
   * a provider call on the path of every text message sent is a provider
   * outage that stops a product from working.
   */
  async record(tenantId: string, meter: string, day: string, quantity: number): Promise<void> {
    await runInTenantTransaction(
      this.dataSource,
      (scoped) =>
        scoped.query(
          `INSERT INTO "mortar_usage_records" ("tenant_id", "meter", "day", "quantity")
           VALUES ($1, $2, $3, $4)
           ON CONFLICT ("tenant_id", "meter", "day")
             DO UPDATE SET "quantity" = "mortar_usage_records"."quantity" + EXCLUDED."quantity",
                           "reported_at" = NULL,
                           "updated_at" = now()`,
          [tenantId, meter, day, quantity],
        ),
      { tenantId },
    );
  }

  /**
   * Tells the provider about everything counted and not yet reported.
   *
   * Run on a schedule. Reads unbound — a sweep is about every tenant, and the
   * row itself says whose it is — and reports each day as one event, which the
   * provider de-duplicates on the reference we send.
   */
  async reportUsage(before = new Date()): Promise<number> {
    const owed = await this.dataSource.query<
      Array<{ id: string; tenant_id: string; meter: string; day: string; quantity: number }>
    >(
      `SELECT "id", "tenant_id", "meter", "day", "quantity"
         FROM "mortar_usage_records"
        WHERE "reported_at" IS NULL AND "day" <= $1::date
        ORDER BY "day"
        LIMIT 1000`,
      [before.toISOString().slice(0, 10)],
    );

    let reported = 0;

    for (const row of owed) {
      const subscription = await this.subscriptionOf(row.tenant_id);

      /*
       * A tenant with no customer has nothing to be billed against — a free
       * plan, or a deployment with no provider. The row stays unreported rather
       * than being marked done, so that signing up later does not lose it.
       */
      if (!subscription?.customerRef) continue;

      await this.provider.reportUsage({
        customer: subscription.customerRef,
        meter: row.meter,
        quantity: Number(row.quantity),
        at: new Date(`${row.day}T12:00:00Z`),
        reference: `${row.tenant_id}-${row.meter}-${row.day}`,
      });

      await this.dataSource.query(
        `UPDATE "mortar_usage_records" SET "reported_at" = now() WHERE "id" = $1`,
        [row.id],
      );

      reported += 1;
    }

    return reported;
  }

  // ── What the provider says afterwards ────────────────────────────────────

  /**
   * Records what a webhook said.
   *
   * A subscription this deployment has no record of is **ignored rather than
   * inserted**: it belongs to another environment sharing the provider account,
   * and inventing a row for it would give somebody else's customer our product.
   */
  async settle(event: BillingEvent): Promise<boolean> {
    if (event.kind === 'subscription' && event.subscription) {
      const tenantId = await this.tenantFor(event);
      if (!tenantId) return false;

      await this.remember(tenantId, {
        status: event.subscription.status,
        quantity: event.subscription.quantity,
        externalId: event.subscription.externalId,
        currentPeriodEnd: event.subscription.currentPeriodEnd,
        cancelAt: event.subscription.cancelAt,
        // Cleared here rather than only on `invoice.paid`, because a
        // subscription that has gone back to active is one that was paid.
        ...(event.subscription.status === 'past_due' ? {} : { pastDueSince: null }),
      });

      return true;
    }

    if (event.kind === 'invoice') {
      const tenantId = await this.tenantFor(event);
      if (!tenantId) return false;

      await this.remember(tenantId, {
        ...(event.paid
          ? { pastDueSince: null }
          : { status: 'past_due' as const, pastDueSince: new Date() }),
      });

      return true;
    }

    return false;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Whose subscription an event is about.
   *
   * By the subject we set on the way out where there is one, and by the
   * provider's identifier otherwise — read unbound, because a webhook carries
   * no tenant and the row itself says whose it is.
   */
  private async tenantFor(event: BillingEvent): Promise<string | null> {
    if (event.subject?.startsWith('tenant:')) return event.subject.slice('tenant:'.length);

    const rows = await this.dataSource.query<Array<{ tenant_id: string }>>(
      `SELECT "tenant_id" FROM "mortar_subscriptions"
        WHERE "external_id" = $1 OR "customer_ref" = $1
        LIMIT 1`,
      [event.externalId],
    );

    return rows[0]?.tenant_id ?? null;
  }

  /** Creates or updates the one subscription row this tenant has. */
  private async remember(tenantId: string, patch: Partial<Subscription>): Promise<void> {
    await runInTenantTransaction(
      this.dataSource,
      async (scoped) => {
        const repository = scoped.getRepository(Subscription);
        const existing = await repository.findOne({ where: { tenantId } });

        if (existing) {
          await repository.update({ id: existing.id, tenantId }, patch);
          return;
        }

        await repository.save(repository.create({ tenantId, ...patch }));
      },
      { tenantId },
    );
  }
}

/** The stored row as the pure functions want it. */
function asPlan(row: BillingPlan): Plan {
  return {
    code: row.code,
    name: row.name,
    interval: row.interval,
    currency: row.currency,
    basePrice: Number(row.basePrice),
    includedQuantity: row.includedQuantity,
    tiers: row.tiers ?? [],
    limits: row.limits ?? {},
    features: row.features ?? [],
    trialDays: row.trialDays,
  };
}
