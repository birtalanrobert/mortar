export { databaseEnvSchema, type DatabaseEnv } from './config';
export { snakeCase } from './case';
export { SnakeCaseNamingStrategy } from './naming';
export {
  buildDataSourceOptions,
  createDataSource,
  type CreateDataSourceOptions,
} from './data-source';
export {
  BaseEntity,
  CURRENCY_COLUMN,
  JSON_COLUMN,
  MONEY_AMOUNT_COLUMN,
  TIMESTAMP_COLUMN,
} from './entity';
export { checkDatabaseHealth, type DatabaseHealth } from './health';
export {
  assertMigrationsUpToDate,
  getMigrationStatus,
  runMigrations,
  runMigrationsWithLock,
  type MigrationStatus,
} from './migrations';
export {
  afterCommit,
  bindTransactionManager,
  getTransactionManager,
  isInTransaction,
  resolveManager,
  runInTransaction,
  transactionDepth,
  type TransactionOptions,
} from './transaction';
export {
  DatabaseModule,
  DatabaseService,
  InjectDataSource,
  MORTAR_DATA_SOURCE,
  type DatabaseModuleOptions,
} from './nest';
export { TEST_DATABASE_URL, createTestDataSource, isTestDatabaseAvailable } from './testing';
