import { DataSource, type MigrationInterface, type QueryRunner } from 'typeorm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildDataSourceOptions } from './data-source';
import { TEST_DATABASE_URL } from './testing';
import { assertMigrationsUpToDate, getMigrationStatus, runMigrationsWithLock } from './migrations';

/**
 * A migration slow enough that two concurrent runs genuinely overlap.
 *
 * Without the delay both processes tend to finish inside the window where
 * neither has committed, and the race the lock exists to prevent does not
 * reproduce reliably.
 */
export class CreateLockProbe1787740000000 implements MigrationInterface {
  name = 'CreateLockProbe1787740000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('SELECT pg_sleep(0.2)');
    await queryRunner.query(`CREATE TABLE "lock_probe" ("id" text PRIMARY KEY)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "lock_probe"`);
  }
}

const connect = async (): Promise<DataSource> => {
  const dataSource = new DataSource({
    ...buildDataSourceOptions({
      url: TEST_DATABASE_URL,
      migrations: [CreateLockProbe1787740000000],
      applicationName: 'mortar-tests',
    }),
  });
  await dataSource.initialize();
  return dataSource;
};

const opened: DataSource[] = [];

beforeEach(async () => {
  const dataSource = await connect();
  await dataSource.query('DROP TABLE IF EXISTS "lock_probe"');
  await dataSource.query('DROP TABLE IF EXISTS "migrations"');
  await dataSource.destroy();
});

afterAll(async () => {
  await Promise.all(opened.filter((d) => d.isInitialized).map((d) => d.destroy()));
});

describe('runMigrationsWithLock', () => {
  it('applies pending migrations', async () => {
    const dataSource = await connect();
    opened.push(dataSource);

    expect(await runMigrationsWithLock(dataSource)).toEqual(['CreateLockProbe1787740000000']);
    await expect(assertMigrationsUpToDate(dataSource)).resolves.toBeUndefined();
  });

  /**
   * The reason the lock exists.
   *
   * Two replicas starting together both see the same pending migration. TypeORM
   * takes no lock of its own, so without one the second to reach `CREATE TABLE`
   * fails with "relation already exists" and that container crash-loops. With
   * the lock, exactly one applies it and the other finds nothing to do.
   */
  it('serialises concurrent runs rather than letting both apply', async () => {
    const [first, second] = await Promise.all([connect(), connect()]);
    opened.push(first, second);

    const results = await Promise.all([
      runMigrationsWithLock(first),
      runMigrationsWithLock(second),
    ]);

    const applied = results.flat();
    expect(applied).toEqual(['CreateLockProbe1787740000000']);

    const { pending } = await getMigrationStatus(first);
    expect(pending).toHaveLength(0);
  });

  it('releases the lock, so a later run is not blocked by an earlier one', async () => {
    const dataSource = await connect();
    opened.push(dataSource);

    await runMigrationsWithLock(dataSource);
    // Would hang rather than fail if the lock leaked, so the suite timeout is
    // what reports it.
    expect(await runMigrationsWithLock(dataSource)).toEqual([]);

    const [{ count }] = await dataSource.query<[{ count: string }]>(
      `SELECT count(*)::text AS count FROM pg_locks WHERE locktype = 'advisory'`,
    );
    expect(count).toBe('0');
  });
});
