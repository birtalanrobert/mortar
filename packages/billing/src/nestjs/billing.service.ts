import { Inject, Injectable } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { InjectDataSource } from '@birtalanrobert/database';
import { runInTenantTransaction } from '@birtalanrobert/tenancy';
import { ConflictError, NotFoundError } from '@birtalanrobert/http';
import {
  dunningStage,
  isEntitled,
  nextPeriodEnd,
  type DunningStage,
  type SubscriptionStatus,
} from '../subscriptions';
import { hasFeature, withinLimit, type Plan } from '../plans';
import type { BillingEvent, BillingProvider } from '../providers/port';
import { BillingPlan } from './plan.entity';
import { Subscription } from './subscription.entity';

/** The provider this deployment uses, injected so tests can supply their own. */
export const BILLING_PROVIDER = Symbol('BILLING_PROVIDER');

/** What one meter came to over a period. */
export interface UsageTotal {
  readonly meter: string;
  readonly quantity: number;
}

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

  /**
   * Puts a business on a plan without sending anybody to a payment page.
   *
   * **Every one of these products has an operator who needs this**, and it is
   * not a way around paying: a chain is sold to rather than checked out, a
   * pilot runs for three months on somebody's word, and a business migrating
   * from a competitor is put on the plan it agreed to before a card is ever
   * entered. Until this existed, a deployment with no provider configured could
   * never have a subscription row at all — the only path went through a hosted
   * checkout — so every screen that shows what a business pays had nothing to
   * show, and the product could not be demonstrated at all before a Stripe
   * account existed.
   *
   * **It refuses to touch a subscription the provider owns.** Once there is an
   * `externalId`, the provider is charging a card on a schedule, and writing a
   * different plan code beside it would make our screen and their invoice
   * disagree — with the customer believing whichever they saw first. Changing a
   * paid plan is a provider operation; changing *how many* is `setQuantity`,
   * which tells the provider.
   *
   * The caller records who did it and why. This package knows nothing about
   * operators, and an audit entry written here would be written without one.
   */
  async assign(
    tenantId: string,
    input: {
      planCode: string;
      quantity?: number;
      /** `trialing` starts the plan's trial from now. Default `active`. */
      status?: Extract<SubscriptionStatus, 'trialing' | 'active' | 'paused' | 'cancelled'>;
      /** When the current period ends. Computed from the interval if omitted. */
      currentPeriodEnd?: Date | null;
      now?: Date;
    },
  ): Promise<Standing> {
    const plan = await this.plan(input.planCode);
    if (!plan) throw new NotFoundError('Plan', input.planCode);

    const existing = await this.subscriptionOf(tenantId);

    if (existing?.externalId) {
      throw new ConflictError(
        'This subscription is managed by the payment provider; change it there.',
      );
    }

    const now = input.now ?? new Date();
    const status = input.status ?? 'active';

    await this.remember(tenantId, {
      planCode: input.planCode,
      status,
      quantity: Math.max(0, Math.ceil(input.quantity ?? existing?.quantity ?? 0)),
      /*
       * A period end even though nobody is charging a card yet.
       *
       * It is what "your next charge" is measured to, and a plan assigned with
       * no date on it produces a screen that cannot say when anything happens.
       */
      currentPeriodEnd:
        input.currentPeriodEnd === undefined
          ? nextPeriodEnd(now, plan.interval)
          : input.currentPeriodEnd,
      trialEndsAt:
        status === 'trialing' && plan.trialDays > 0
          ? new Date(now.getTime() + plan.trialDays * 86_400_000)
          : null,
      /* Not past due: nobody has been asked for money yet. */
      pastDueSince: null,
      cancelAt: null,
    });

    return this.standingOf(tenantId);
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
   * Sets what a tenant used on a day, replacing whatever was counted before.
   *
   * The other shape of metering, and both are needed. {@link record} is for a
   * product that counts an **event** as it happens — a text message sent, a
   * pack bought — where adding is the only correct arithmetic and running twice
   * would mean it happened twice. This is for a product that counts a **table**
   * on a schedule: tickets issued yesterday, read out of the rows that record
   * them. There, adding is the wrong arithmetic in both directions — a second
   * run doubles the day, and a ticket refunded after the first run never comes
   * back off.
   *
   * A product that tried to express this with `record` would have to remember
   * what it last counted, which means reading this table from outside the
   * package that owns it.
   *
   * **An unchanged count is not re-reported.** Clearing `reported_at`
   * unconditionally would send a day to the provider again every night for as
   * long as the aggregation keeps finding the same answer, which is every night
   * after the first. The provider de-duplicates on the reference we send, so
   * the charge would be right and the noise would be real; a provider that does
   * not is a double charge. Only a day whose figure actually moved is owed
   * again.
   */
  async recount(tenantId: string, meter: string, day: string, quantity: number): Promise<void> {
    await runInTenantTransaction(
      this.dataSource,
      (scoped) =>
        scoped.query(
          `INSERT INTO "mortar_usage_records" ("tenant_id", "meter", "day", "quantity")
           VALUES ($1, $2, $3, $4)
           ON CONFLICT ("tenant_id", "meter", "day")
             DO UPDATE SET "quantity" = EXCLUDED."quantity",
                           "reported_at" = CASE
                             WHEN "mortar_usage_records"."quantity" = EXCLUDED."quantity"
                               THEN "mortar_usage_records"."reported_at"
                             ELSE NULL
                           END,
                           "updated_at" = now()`,
          [tenantId, meter, day, quantity],
        ),
      { tenantId },
    );
  }

  /**
   * What a tenant used between two days, per meter. Both ends included.
   *
   * Here rather than in the product because the alternative is a product
   * writing `SELECT … FROM "mortar_usage_records"` for itself, against a table
   * with a forced policy on it — which returns no rows and reports success from
   * an unbound connection, and is the failure this service has already been
   * caught by once.
   *
   * Days rather than timestamps, because that is what a usage record is: a
   * product aggregating a table decides for itself which timezone a day ends
   * in, and a period boundary read in UTC would move a venue's last night of
   * the month into the next one.
   */
  async usageBetween(tenantId: string, from: string, to: string): Promise<UsageTotal[]> {
    const rows = await runInTenantTransaction(
      this.dataSource,
      (scoped) =>
        scoped.query<Array<{ meter: string; quantity: string }>>(
          `SELECT "meter", SUM("quantity") AS "quantity"
             FROM "mortar_usage_records"
            WHERE "tenant_id" = $1 AND "day" >= $2::date AND "day" <= $3::date
            GROUP BY "meter"
            ORDER BY "meter"`,
          [tenantId, from, to],
        ),
      { tenantId },
    );

    return rows.map((row) => ({ meter: row.meter, quantity: Number(row.quantity) }));
  }

  /**
   * Tells the provider about everything counted and not yet reported.
   *
   * **Driven from the caller's registry, and bound inside each tenant.** This
   * read used to be unbound, with a docblock saying a sweep is about every
   * tenant and the row itself says whose it is. That reasoning is wrong here
   * and the failure it caused is the quiet kind: `mortar_usage_records` carries
   * `FORCE ROW LEVEL SECURITY`, which applies to the table owner too, so an
   * unbound `SELECT` returns **no rows and reports success** — the nightly
   * sweep reported nothing, every night, and said it had reported nothing,
   * which is exactly what a night with no usage looks like.
   *
   * There is no way for this package to enumerate tenants for itself: the only
   * table it could read them from is the one behind the policy. So the caller
   * passes them, which is correct in any case — the product owns the register
   * of who exists, and this owns what they used.
   *
   * Each day is reported as one event, which the provider de-duplicates on the
   * reference we send.
   */
  async reportUsage(tenants: readonly string[], before = new Date()): Promise<number> {
    const owed: Array<{
      id: string;
      tenant_id: string;
      meter: string;
      day: string;
      quantity: number;
    }> = [];

    for (const tenantId of tenants) {
      const rows = await runInTenantTransaction(
        this.dataSource,
        (scoped) =>
          scoped.query<
            Array<{ id: string; tenant_id: string; meter: string; day: string; quantity: number }>
          >(
            `SELECT "id", "tenant_id", "meter", "day", "quantity"
               FROM "mortar_usage_records"
              WHERE "tenant_id" = $1 AND "reported_at" IS NULL AND "day" <= $2::date
              ORDER BY "day"
              LIMIT 1000`,
            [tenantId, before.toISOString().slice(0, 10)],
          ),
        { tenantId },
      );

      owed.push(...rows);
    }

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

      /* Bound as well, for the same reason: the `UPDATE` sees no rows without it. */
      await runInTenantTransaction(
        this.dataSource,
        (scoped) =>
          scoped.query(`UPDATE "mortar_usage_records" SET "reported_at" = now() WHERE "id" = $1`, [
            row.id,
          ]),
        { tenantId: row.tenant_id },
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
      const tenantId = this.tenantFor(event);
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
      const tenantId = this.tenantFor(event);
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
  private tenantFor(event: BillingEvent): string | null {
    /*
     * From the metadata we set on the way out, and nowhere else.
     *
     * The obvious alternative — look the provider's customer up in our own
     * subscriptions table — **cannot work**, and fails in the worst way:
     * `mortar_subscriptions` is under `FORCE ROW LEVEL SECURITY`, so a query
     * with no tenant bound returns *no rows at all* rather than an error. The
     * webhook then verifies, reads, understands and changes nothing, and the
     * only evidence is a business that runs unpaid for ever.
     *
     * A subscription carries the subject because we put it there; an invoice
     * carries a snapshot of the subscription's metadata for the same reason.
     * An event with neither is about something this deployment did not create.
     */
    return event.subject?.startsWith('tenant:') ? event.subject.slice('tenant:'.length) : null;
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
