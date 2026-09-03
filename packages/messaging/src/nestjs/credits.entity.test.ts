import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getMetadataArgsStorage } from 'typeorm';
import { MessageCreditEntry } from './credits.entity';

/**
 * The entity and the migration have to name the same table.
 *
 * They diverged once — the decorator said `message_credits` and the migration
 * created `mortar_message_credits` — and nothing caught it: both files compile,
 * both typecheck, and the failure appears only when a query runs against a real
 * database. That is a whole release cycle away from the mistake.
 */
describe('the credit ledger entity', () => {
  const tableOf = (target: unknown) =>
    getMetadataArgsStorage().tables.find((table) => table.target === target)?.name;

  it('is mapped to the table the migration creates', () => {
    const migration = readFileSync(
      join(__dirname, '../migrations/1788390000000-CreateMessageCredits.ts'),
      'utf8',
    );

    const table = tableOf(MessageCreditEntry);
    expect(table).toBe('mortar_message_credits');
    expect(migration).toContain(`CREATE TABLE "${table}"`);
  });

  it('carries the mortar prefix every shared table carries', () => {
    // Products own their own schema; a package that dropped an unprefixed table
    // into it is a package that will collide with somebody's own `payments`.
    expect(tableOf(MessageCreditEntry)).toMatch(/^mortar_/);
  });
});
