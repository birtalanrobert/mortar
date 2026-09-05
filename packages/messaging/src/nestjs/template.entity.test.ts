import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getMetadataArgsStorage } from 'typeorm';
import { MessageTemplate } from './template.entity';

/**
 * The entity and the migration have to name the same table.
 *
 * A decorator string and a SQL string are never compared by the compiler, and
 * the failure appears only when a query runs against a real database — a whole
 * release away from the mistake. The credit ledger's pair diverged exactly once
 * and that is why this test exists for every shared table.
 */
describe('the message template entity', () => {
  const tableOf = (target: unknown) =>
    getMetadataArgsStorage().tables.find((table) => table.target === target)?.name;

  const migration = readFileSync(
    join(__dirname, '../migrations/1789300000000-CreateMessageTemplates.ts'),
    'utf8',
  );

  it('is mapped to the table the migration creates', () => {
    const table = tableOf(MessageTemplate);
    expect(table).toBe('mortar_message_templates');
    expect(migration).toContain(`CREATE TABLE "${table}"`);
  });

  it('carries the mortar prefix every shared table carries', () => {
    expect(tableOf(MessageTemplate)).toMatch(/^mortar_/);
  });

  it('is unique on the four things that identify one piece of text', () => {
    // A tenant, an event, a channel and a language. Without the index, two
    // tabs saving at once leave a business with two versions and no way to
    // tell which one is sent.
    expect(migration).toContain('uq_message_templates_key');
    expect(migration).toContain('"tenant_id", "event", "channel", "locale"');
  });

  it('does not enumerate anybody’s events', () => {
    /*
     * A check constraint listing `booking.reminder24h` is what would stop this
     * table being shared: one product's events are not another's. The channel
     * is constrained, because there really are only three.
     */
    expect(migration).not.toMatch(/CHECK\s*\("event"/);
    expect(migration).toContain('ck_message_templates_channel');
  });
});
