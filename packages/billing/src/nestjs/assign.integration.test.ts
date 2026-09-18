import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDataSource } from '@birtalanrobert/database';
import { runInTenantTransaction } from '@birtalanrobert/tenancy';
import type { DataSource } from 'typeorm';
import { BillingService } from './billing.service';
import { BillingPlan } from './plan.entity';
import { Subscription } from './subscription.entity';
import { UsageRecord } from './usage-record.entity';
import { CreateBilling1790200000000 } from '../migrations/1790200000000-CreateBilling';
import { NoBilling } from '../providers/none';

const TENANT = '11111111-1111-4111-8111-111111111111';

let dataSource: DataSource;

beforeEach(async () => {
  dataSource ??= await createTestDataSource([BillingPlan, Subscription, UsageRecord], {
    /* The real migration, because the row-level security policy is part of what
       is under test and `synchronize` does not create one. */
    migrations: [CreateBilling1790200000000],
  });

  await dataSource.query(`TRUNCATE TABLE "mortar_usage_records", "mortar_subscriptions"`);
  await dataSource.query(`DELETE FROM "mortar_plans"`);

  await dataSource.getRepository(BillingPlan).save(
    dataSource.getRepository(BillingPlan).create({
      code: 'chain',
      name: 'Chain',
      interval: 'month',
      currency: 'RON',
      /* A string, because money is a numeric column read back as one: a float
         is how a price ends up at 49899.999999. */
      basePrice: '49900',
      includedQuantity: 1,
      tiers: [{ upTo: null, unitPrice: 9_900 }],
      limits: { locations: null },
      features: ['campaigns'],
      trialDays: 14,
      sellable: true,
    }),
  );
});

afterAll(async () => {
  if (dataSource?.isInitialized) await dataSource.destroy();
});

/**
 * A plan put on by an operator rather than bought through a payment page.
 *
 * A chain is sold to rather than checked out, a pilot runs on somebody's word,
 * and a business migrating from a competitor is put on the plan it agreed to
 * before a card is ever entered. Until this existed a deployment with no
 * provider could never have a subscription row at all, and every screen that
 * says what a business pays had nothing to show.
 */
describe('assigning a plan', () => {
  const billing = () => new BillingService(dataSource, new NoBilling());

  it('puts a business on a plan with no provider configured at all', async () => {
    const standing = await billing().assign(TENANT, { planCode: 'chain', quantity: 9 });

    expect(standing).toMatchObject({ status: 'active', quantity: 9, entitled: true });
    expect(standing.plan?.code).toBe('chain');
    /* Something for a screen to say "your next charge is on" about. */
    expect(standing.currentPeriodEnd).toBeInstanceOf(Date);
  });

  it('refuses a plan nobody sells', async () => {
    await expect(billing().assign(TENANT, { planCode: 'invented' })).rejects.toThrow(/Plan/);
  });

  it('starts the trial when asked, and not otherwise', async () => {
    const trial = await billing().assign(TENANT, { planCode: 'chain', status: 'trialing' });

    expect(trial.status).toBe('trialing');
    expect(trial.trialEndsAt).toBeInstanceOf(Date);

    const active = await billing().assign(TENANT, { planCode: 'chain' });

    expect(active.status).toBe('active');
    expect(active.trialEndsAt).toBeNull();
  });

  /**
   * The refusal that keeps one source of truth.
   *
   * Once the provider is charging a card on a schedule, writing a different
   * plan code beside it makes our screen and their invoice disagree — and the
   * customer believes whichever they saw first.
   */
  it('refuses to touch a subscription the provider owns', async () => {
    await billing().assign(TENANT, { planCode: 'chain', quantity: 2 });

    await runInTenantTransaction(
      dataSource,
      (scoped) => scoped.query(`UPDATE "mortar_subscriptions" SET "external_id" = 'sub_123'`),
      { tenantId: TENANT },
    );

    await expect(billing().assign(TENANT, { planCode: 'chain' })).rejects.toThrow(/provider/);
  });

  it('keeps the quantity it already had when none is given', async () => {
    await billing().assign(TENANT, { planCode: 'chain', quantity: 9 });

    expect((await billing().assign(TENANT, { planCode: 'chain' })).quantity).toBe(9);
  });

  /* The row is written inside the tenant, which is the trap this table sets:
     `mortar_subscriptions` carries FORCE ROW LEVEL SECURITY, so an unbound
     write changes nothing and reports success. */
  it('writes a row the tenant can actually read back', async () => {
    await billing().assign(TENANT, { planCode: 'chain', quantity: 4 });

    const rows = await runInTenantTransaction(
      dataSource,
      (scoped) =>
        scoped.query<Array<{ plan_code: string; quantity: number }>>(
          `SELECT "plan_code", "quantity" FROM "mortar_subscriptions"`,
        ),
      { tenantId: TENANT },
    );

    expect(rows).toEqual([{ plan_code: 'chain', quantity: 4 }]);
  });
});
