import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getMetadataArgsStorage } from 'typeorm';
import { PublishedRate } from './published-rate.entity';
import { ratesEntities, ratesMigrations } from './registry';

/**
 * The entity's table name against the migration's, which nothing else compares.
 *
 * A decorator string and a SQL string are never checked against each other by
 * the compiler, and a disagreement surfaces only when a query runs — a release
 * away from the mistake that caused it. This is the programme's standing rule
 * for any package that ships both.
 */
const migration = readFileSync(
  join(__dirname, '../migrations/1791000000000-CreatePublishedRates.ts'),
  'utf8',
);

describe('the table this package ships', () => {
  const table = getMetadataArgsStorage().tables.find((one) => one.target === PublishedRate)?.name;

  it('is named the same in the entity and in the migration', () => {
    expect(table).toBe('mortar_published_rates');
    expect(migration).toContain('CREATE TABLE "mortar_published_rates"');
  });

  /**
   * Prefixed, like every other table mortar owns.
   *
   * A package creating an unprefixed table is a package that collides with a
   * product's own the first time both mean something by the same word.
   */
  it('carries mortar’s prefix, as every shared table must', () => {
    expect(table?.startsWith('mortar_')).toBe(true);

    for (const name of migration.matchAll(/CONSTRAINT "([^"]+)"/g)) {
      expect(name[1]).toMatch(/^(pk|uq|ck|fk)_mortar_/);
    }
    for (const name of migration.matchAll(/CREATE (?:UNIQUE )?INDEX "([^"]+)"/g)) {
      expect(name[1]).toMatch(/^ix_mortar_/);
    }
  });

  /**
   * The unique key is what makes re-reading an overlapping feed free, and the
   * feeds overlap on purpose — ten days from the BNR, ninety from the ECB — so
   * that a worker down over a weekend catches up without anybody noticing.
   */
  it('is keyed on the publication day, so a re-read writes nothing twice', () => {
    const unique = getMetadataArgsStorage().uniques.find((one) => one.target === PublishedRate);

    expect(unique?.columns).toEqual(['source', 'base', 'quote', 'asOf']);
    expect(migration).toContain('UNIQUE ("source", "base", "quote", "as_of")');
  });

  it('exports what a consumer has to register', () => {
    expect(ratesEntities).toEqual([PublishedRate]);
    expect(ratesMigrations).toHaveLength(1);
    expect(ratesMigrations[0]?.name).toBe('CreatePublishedRates1791000000000');
  });

  /**
   * No row-level security, deliberately, and asserted so that adding one later
   * is a failing test rather than every charge silently reporting "no rate".
   */
  it('has no row-level security, because a rate belongs to nobody', () => {
    expect(migration).not.toContain('ROW LEVEL SECURITY');
    expect(migration).not.toContain('enableRlsSql');
  });
});
