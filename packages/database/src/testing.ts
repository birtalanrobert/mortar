import { DataSource } from 'typeorm';
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
export async function createTestDataSource(
  entities: Array<new () => object> = [],
): Promise<DataSource> {
  const dataSource = new DataSource({
    ...buildDataSourceOptions({
      url: TEST_DATABASE_URL,
      entities,
      applicationName: 'mortar-tests',
    }),
    // Tests own their schema; migrations are exercised separately.
    synchronize: entities.length > 0,
    dropSchema: entities.length > 0,
  });
  await dataSource.initialize();
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
