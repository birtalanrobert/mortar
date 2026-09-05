import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getMetadataArgsStorage } from 'typeorm';
import { Payment, PaymentRefund } from './payment.entity';
import { PayoutAccount } from './payout-account.entity';
import { SavedCard } from './saved-card.entity';

/**
 * The entities and the migration have to describe the same schema.
 *
 * A decorator string and a SQL string are never compared by the compiler, and
 * the failure appears only when a query runs — a release away from the mistake.
 * The credit ledger's pair diverged exactly once, which is why every shared
 * table has this test.
 */
describe('the commerce entities', () => {
  /*
   * Every migration, not the first one.
   *
   * A column added by a later migration is still a column the entity may read,
   * and reading only the creating file turns each addition into a failure of
   * this test rather than of the thing it is meant to catch.
   */
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
    ['payout accounts', PayoutAccount, 'mortar_payout_accounts'],
    ['payments', Payment, 'mortar_payments'],
    ['refunds', PaymentRefund, 'mortar_payment_refunds'],
    ['saved cards', SavedCard, 'mortar_saved_cards'],
  ])('maps %s to the table the migration creates', (_name, entity, table) => {
    expect(tableOf(entity)).toBe(table);
    expect(migration).toContain(`CREATE TABLE "${table}"`);
  });

  it.each([
    ['payout accounts', PayoutAccount],
    ['payments', Payment],
    ['refunds', PaymentRefund],
    ['saved cards', SavedCard],
  ])('names only columns the migration creates, for %s', (_name, entity) => {
    // A column an entity reads and no migration writes is a query that fails
    // the first time anybody asks for it.
    const missing = columnsOf(entity).filter((name) => !migration.includes(`"${name}"`));
    expect(missing).toEqual([]);
  });

  it('carries the mortar prefix on every table', () => {
    // Products own their own schema; an unprefixed table is one that collides
    // with somebody's own `payments`.
    for (const entity of [PayoutAccount, Payment, PaymentRefund, SavedCard]) {
      expect(tableOf(entity)).toMatch(/^mortar_/);
    }
  });

  it('takes no foreign key to whatever was paid for', () => {
    /*
     * One product takes a deposit against an appointment, another against a
     * seat, a third against a table's tab. A key to any one of them is exactly
     * what would stop this table being shared.
     */
    expect(migration).not.toMatch(/FOREIGN KEY \("tenant_id", "subject"\)/);
    expect(migration).toContain('"subject" varchar(160) NOT NULL');
  });

  it('refuses to let money go negative or be given back twice', () => {
    expect(migration).toContain('ck_payments_amount');
    expect(migration).toContain('"refunded" >= 0 AND "refunded" <= "amount"');
  });

  it('records what a saved card\u2019s owner agreed to, not that they agreed', () => {
    /*
     * A boolean records that somebody clicked. The sentence records what they
     * were told they were agreeing to — and only the second is worth anything
     * when a customer says they were never told their card would be kept.
     */
    expect(migration).toContain('"consent_text" varchar(1000) NOT NULL');
    expect(migration).toContain('"consented_at" timestamptz NOT NULL');
  });

  it('never stores a card number, only enough to recognise one', () => {
    expect(migration).toContain('"last4" varchar(4)');
    expect(migration).not.toMatch(/"(card_)?number"/);
    expect(migration).not.toContain('"cvc"');
  });
});

/** What TypeORM's snake-case strategy does, digits and all. */
const snake = (property: string): string =>
  property.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
