import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getMetadataArgsStorage } from 'typeorm';
import { BillingPlan } from './plan.entity';
import { Subscription } from './subscription.entity';
import { UsageRecord } from './usage-record.entity';

/**
 * The entities and the migration have to describe the same schema.
 *
 * A decorator string and a SQL string are never compared by the compiler, and
 * the failure appears only when a query runs — a release away from the mistake.
 */
describe('the billing entities', () => {
  const directory = join(__dirname, '../migrations');
  const migration = readdirSync(directory)
    .filter((file) => file.endsWith('.ts'))
    .map((file) => readFileSync(join(directory, file), 'utf8'))
    .join('\n');

  const tableOf = (target: unknown) =>
    getMetadataArgsStorage().tables.find((table) => table.target === target)?.name;

  const columnsOf = (target: unknown) =>
    getMetadataArgsStorage()
      .columns.filter((column) => column.target === target)
      .map((column) => column.options.name ?? snake(column.propertyName));

  it.each([
    ['plans', BillingPlan, 'mortar_plans'],
    ['subscriptions', Subscription, 'mortar_subscriptions'],
    ['usage records', UsageRecord, 'mortar_usage_records'],
  ])('maps %s to the table the migration creates', (_name, entity, table) => {
    expect(tableOf(entity)).toBe(table);
    expect(migration).toContain(`CREATE TABLE "${table}"`);
  });

  it.each([
    ['plans', BillingPlan],
    ['subscriptions', Subscription],
    ['usage records', UsageRecord],
  ])('names only columns the migration creates, for %s', (_name, entity) => {
    const missing = columnsOf(entity).filter((name) => !migration.includes(`"${name}"`));
    expect(missing).toEqual([]);
  });

  it('carries the mortar prefix on every table', () => {
    for (const entity of [BillingPlan, Subscription, UsageRecord]) {
      expect(tableOf(entity)).toMatch(/^mortar_/);
    }
  });

  it('stores a subscription’s plan by code rather than by key', () => {
    /*
     * A business that bought "Salon, five staff included" in March keeps those
     * terms when the price list changes in April. A foreign key into a table
     * somebody edits rewrites what they agreed to.
     */
    expect(migration).toContain('"plan_code" varchar(64) NOT NULL');
    expect(migration).not.toMatch(/FOREIGN KEY \("plan_id"\)/);
  });

  it('gives a business exactly one subscription', () => {
    // Two is a business with an argument about which one applies.
    expect(migration).toContain('CONSTRAINT "uq_subscriptions_tenant" UNIQUE ("tenant_id")');
  });

  it('counts usage once per tenant, meter and day', () => {
    // So a retried nightly job updates rather than doubles.
    expect(migration).toContain('UNIQUE ("tenant_id", "meter", "day")');
  });
});

/** What TypeORM's snake-case strategy does, digits and all. */
const snake = (property: string): string =>
  property.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
