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
