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
const OTHER = '22222222-2222-4222-8222-222222222222';

let dataSource: DataSource;

/**
 * Remembers what it was told, so a sweep that reported nothing is visible.
 *
 * The parameter is optional because `NoBilling`'s own `reportUsage` takes none
 * — a no-op has nothing to do with its argument — and an override may accept
 * fewer, never more.
 */
class Recording extends NoBilling {
  readonly reported: Array<{ customer: string; meter: string; quantity: number }> = [];

  override async reportUsage(usage?: {
    customer: string;
    meter: string;
    quantity: number;
    at: Date;
    reference: string;
  }): Promise<void> {
    if (!usage) return;

    this.reported.push({
      customer: usage.customer,
      meter: usage.meter,
      quantity: usage.quantity,
    });
  }
}

beforeEach(async () => {
  dataSource ??= await createTestDataSource([BillingPlan, Subscription, UsageRecord], {
    // The real migration, because **the row-level security policy is the thing
    // under test** and `synchronize` does not create one.
    migrations: [CreateBilling1790200000000],
  });

  await dataSource.query(`TRUNCATE TABLE "mortar_usage_records", "mortar_subscriptions"`);
});

afterAll(async () => {
  if (dataSource?.isInitialized) await dataSource.destroy();
});

/**
 * Reporting usage to a provider, against a table with a policy on it.
 *
 * This file exists because of the defect it would have caught. `reportUsage`
 * read `mortar_usage_records` **unbound**, with a docblock explaining that a
 * sweep is about every tenant — and the table carries `FORCE ROW LEVEL
 * SECURITY`, which applies to the table owner too. The read returned no rows
 * and reported success, so the nightly sweep reported nothing every night and
 * said so, which is indistinguishable from a night with no usage.
 *
 * Only a real PostgreSQL shows this. Every unit test passed throughout.
 */
describe('reporting what a tenant used', () => {
  const subscribe = async (tenantId: string, customerRef: string) =>
    runInTenantTransaction(
      dataSource,
      (scoped) =>
        scoped.query(
          `INSERT INTO "mortar_subscriptions"
             ("tenant_id", "plan_code", "status", "customer_ref")
           VALUES ($1, 'standard', 'active', $2)`,
          [tenantId, customerRef],
        ),
      { tenantId },
    );

  const billing = (provider: Recording) => new BillingService(dataSource, provider);

  it('reports a day that was counted', async () => {
    const provider = new Recording();
    const service = billing(provider);

    await subscribe(TENANT, 'cus_one');
    await service.record(TENANT, 'sms.segments', '2026-09-01', 12);

    const reported = await service.reportUsage([TENANT], new Date('2026-09-02'));

    expect(reported).toBe(1);
    expect(provider.reported).toEqual([
      { customer: 'cus_one', meter: 'sms.segments', quantity: 12 },
    ]);
  });

  /**
   * The assertion that would have caught it.
   *
   * An unbound sweep returns nothing and reports nothing, which looks exactly
   * like a quiet night — so the test has to assert that something *was*
   * reported rather than that nothing broke.
   */
  it('does not silently report nothing for a tenant that used something', async () => {
    const provider = new Recording();
    const service = billing(provider);

    await subscribe(TENANT, 'cus_one');
    await service.record(TENANT, 'sms.segments', '2026-09-01', 5);

    await service.reportUsage([TENANT], new Date('2026-09-02'));

    expect(provider.reported).not.toEqual([]);
  });

  it('marks what it reported, so a second sweep does not bill twice', async () => {
    const provider = new Recording();
    const service = billing(provider);

    await subscribe(TENANT, 'cus_one');
    await service.record(TENANT, 'sms.segments', '2026-09-01', 7);

    await service.reportUsage([TENANT], new Date('2026-09-02'));
    const again = await service.reportUsage([TENANT], new Date('2026-09-02'));

    expect(again).toBe(0);
    expect(provider.reported).toHaveLength(1);
  });

  it('reports each tenant it is given, and no other', async () => {
    const provider = new Recording();
    const service = billing(provider);

    await subscribe(TENANT, 'cus_one');
    await subscribe(OTHER, 'cus_two');
    await service.record(TENANT, 'sms.segments', '2026-09-01', 3);
    await service.record(OTHER, 'sms.segments', '2026-09-01', 9);

    await service.reportUsage([TENANT], new Date('2026-09-02'));

    expect(provider.reported).toEqual([
      { customer: 'cus_one', meter: 'sms.segments', quantity: 3 },
    ]);
  });

  /**
   * A tenant with no customer has nothing to be billed against — a free plan,
   * or a deployment with no provider. The row stays unreported rather than
   * being marked done, so signing up later does not lose it.
   */
  it('keeps a day owed when there is nobody to bill', async () => {
    const provider = new Recording();
    const service = billing(provider);

    await service.record(TENANT, 'sms.segments', '2026-09-01', 4);

    expect(await service.reportUsage([TENANT], new Date('2026-09-02'))).toBe(0);

    await subscribe(TENANT, 'cus_one');

    expect(await service.reportUsage([TENANT], new Date('2026-09-02'))).toBe(1);
  });

  it('leaves a day that has not finished alone', async () => {
    const provider = new Recording();
    const service = billing(provider);

    await subscribe(TENANT, 'cus_one');
    await service.record(TENANT, 'sms.segments', '2026-09-05', 2);

    expect(await service.reportUsage([TENANT], new Date('2026-09-02'))).toBe(0);
  });

  it('is asked for no tenants and does nothing', async () => {
    expect(await billing(new Recording()).reportUsage([])).toBe(0);
  });
});
