import { DataSource, type MixedList } from 'typeorm';
import { buildDataSourceOptions } from './data-source';

/**
 * Connection string for mortar's own test database.
 *
 * Port 3050 sits outside the 3100-4799 range the seventeen projects allocate
 * from, so mortar's tests can never touch a project's local data.
 */
export const TEST_DATABASE_URL =
  process.env.MORTAR_TEST_DATABASE_URL ?? 'postgres://mortar:mortar@localhost:3050/mortar_test';

/**
 * Creates and initializes a DataSource against the test database.
 *
 * Exported from the package rather than kept in a test file because
 * `@mortar/audit`, `@mortar/idempotency`, `@mortar/tenancy` and `@mortar/auth`
 * all need exactly this, and each writing its own would guarantee four subtly
 * different setups.
 */
export interface TestDataSourceOptions {
  /**
   * Migrations to run instead of synchronizing from entity metadata.
   *
   * Strongly preferred when a package ships migrations. `synchronize` builds
   * the schema from decorators, which silently skips everything a migration
   * does beyond columns and indexes — triggers, constraints, functions,
   * grants. A package whose migration is never executed in a test has an
   * untested migration, and the first place it runs for real is production.
   */
  migrations?: MixedList<string | (new () => object)>;
}

export async function createTestDataSource(
  entities: Array<new () => object> = [],
  options: TestDataSourceOptions = {},
): Promise<DataSource> {
  const useMigrations = Boolean(options.migrations);

  const dataSource = new DataSource({
    ...buildDataSourceOptions({
      url: TEST_DATABASE_URL,
      entities,
      migrations: options.migrations ?? [],
      applicationName: 'mortar-tests',
    }),
    synchronize: !useMigrations && entities.length > 0,
    dropSchema: useMigrations || entities.length > 0,
  });

  await dataSource.initialize();
  if (useMigrations) await dataSource.runMigrations({ transaction: 'all' });
  return dataSource;
}

/** Whether the test database is reachable, for skipping when it is not. */
export async function isTestDatabaseAvailable(): Promise<boolean> {
  const probe = new DataSource(
    buildDataSourceOptions({ url: TEST_DATABASE_URL, connectTimeoutMs: 1500 }),
  );
  try {
    await probe.initialize();
    await probe.destroy();
    return true;
  } catch {
    return false;
  }
}
