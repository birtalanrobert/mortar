import { MigrationExecutor, type DataSource } from 'typeorm';

export interface MigrationStatus {
  readonly executed: readonly string[];
  readonly pending: readonly string[];
}

/**
 * Reports which migrations have run and which have not.
 *
 * Worth exposing on an admin surface: "why is this column missing on staging"
 * is answered in one glance, and a deploy that half-migrated is visible rather
 * than inferred.
 */
export async function getMigrationStatus(dataSource: DataSource): Promise<MigrationStatus> {
  const queryRunner = dataSource.createQueryRunner();
  try {
    const executor = new MigrationExecutor(dataSource, queryRunner);
    const [executed, pending] = await Promise.all([
      executor.getExecutedMigrations(),
      executor.getPendingMigrations(),
    ]);
    return {
      executed: executed.map((migration) => migration.name),
      pending: pending.map((migration) => migration.name),
    };
  } finally {
    await queryRunner.release();
  }
}

/**
 * Runs pending migrations inside a single transaction.
 *
 * `transaction: 'all'` so a failure halfway leaves the schema untouched rather
 * than in a state no migration file describes.
 */
export async function runMigrations(dataSource: DataSource): Promise<string[]> {
  const applied = await dataSource.runMigrations({ transaction: 'all' });
  return applied.map((migration) => migration.name);
}

/**
 * A stable 64-bit key for the migration advisory lock.
 *
 * Arbitrary but fixed: any two processes running this code must choose the
 * same number, and it must not collide with a lock the application takes for
 * its own reasons. Advisory locks share one namespace per database.
 */
const MIGRATION_LOCK_ID = 8_432_119_570_442_113n;

/**
 * Runs pending migrations, holding an advisory lock for the duration.
 *
 * The lock is the whole point. Several replicas starting at once all see the
 * same pending list and all begin applying it; TypeORM takes no lock of its
 * own, so the second one to reach a `CREATE TABLE` fails and that container
 * crash-loops. With the lock, one applies and the rest wait, find nothing
 * pending, and carry on.
 *
 * `pg_advisory_lock` rather than `pg_try_advisory_lock`: a replica that cannot
 * get the lock should wait for the migration to finish, not skip it and start
 * serving traffic against a schema that is still moving.
 */
export async function runMigrationsWithLock(dataSource: DataSource): Promise<string[]> {
  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();

  try {
    // Session-scoped, so it is held across the migration's own transactions
    // and released explicitly below.
    await queryRunner.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID.toString()]);
    try {
      return await runMigrations(dataSource);
    } finally {
      await queryRunner.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID.toString()]);
    }
  } finally {
    // Releasing the connection would drop a session lock anyway, but doing it
    // explicitly means the lock is gone before the next statement runs rather
    // than whenever the pool decides.
    await queryRunner.release();
  }
}

/**
 * Throws if any migration is pending.
 *
 * Called at boot by services that must not serve traffic against a schema
 * older than the code expects — which is most of them.
 */
export async function assertMigrationsUpToDate(dataSource: DataSource): Promise<void> {
  const { pending } = await getMigrationStatus(dataSource);
  if (pending.length > 0) {
    throw new Error(
      `Database schema is behind the code. ${pending.length} migration(s) pending:\n` +
        pending.map((name) => `  • ${name}`).join('\n'),
    );
  }
}
