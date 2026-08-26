import {
  Global,
  Inject,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import type { AsyncModuleOptions } from '@birtalanrobert/context';
import { DataSource, type EntityManager, type EntityTarget, type Repository } from 'typeorm';
import { createDataSource, type CreateDataSourceOptions } from './data-source';
import { checkDatabaseHealth, type DatabaseHealth } from './health';
import {
  assertMigrationsUpToDate,
  getMigrationStatus,
  runMigrationsWithLock,
  type MigrationStatus,
} from './migrations';
import { runInTransaction, resolveManager, type TransactionOptions } from './transaction';

export const MORTAR_DATA_SOURCE = Symbol('MORTAR_DATA_SOURCE');

/** Injects the raw TypeORM DataSource. */
export const InjectDataSource = () => Inject(MORTAR_DATA_SOURCE);

/**
 * The injectable face of this package.
 *
 * Application services depend on `DatabaseService` rather than reaching for
 * the DataSource directly, so that transaction-awareness is the default: every
 * repository obtained through `getRepository()` is bound to the active
 * transaction if one is open, and to the pool if not.
 */
export class DatabaseService {
  constructor(readonly dataSource: DataSource) {}

  /** The EntityManager for the current context — transactional if inside one. */
  get manager(): EntityManager {
    return resolveManager(this.dataSource);
  }

  /**
   * A repository bound to the current context.
   *
   * Note this must be called *inside* the transaction, not cached across it —
   * the binding is resolved per call, which is what keeps it correct.
   */
  getRepository<T extends object>(entity: EntityTarget<T>): Repository<T> {
    return this.manager.getRepository(entity);
  }

  /** Runs work in a transaction, joining an existing one via savepoint. */
  transaction<T>(
    work: (manager: EntityManager) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T> {
    return runInTransaction(this.dataSource, work, options);
  }

  health(timeoutMs?: number): Promise<DatabaseHealth> {
    return checkDatabaseHealth(this.dataSource, timeoutMs);
  }

  migrationStatus(): Promise<MigrationStatus> {
    return getMigrationStatus(this.dataSource);
  }
}

export interface DatabaseModuleOptions extends CreateDataSourceOptions {
  /**
   * Apply pending migrations at boot, before anything is served.
   *
   * Safe with several replicas: the run is guarded by a Postgres advisory
   * lock, so one applies while the rest wait and then find nothing pending.
   *
   * Whether to use it is a deployment question, not a correctness one. It
   * removes a manual step and the class of incident where someone forgets it;
   * what it gives up is the ability to migrate at a moment of your choosing,
   * separately from the rollout — which matters once a migration takes long
   * enough to lock a table people are using.
   */
  migrationsRun?: boolean;

  /**
   * Refuse to start when migrations are pending. Defaults to true outside
   * development — a service serving traffic against a schema older than its
   * code produces confusing failures far from their cause.
   *
   * Redundant with `migrationsRun`, and harmless alongside it: after a
   * successful run nothing is pending, so the assertion simply passes. Left on
   * because it is what catches a run that silently applied nothing.
   */
  assertMigrations?: boolean;
}

/**
 * Opens the connection and brings the schema to where the code expects it.
 *
 * Shared by both factories rather than written twice, because the two differing
 * by accident is exactly the bug nobody finds until the async path is the one
 * production uses.
 */
async function initializeDataSource(options: DatabaseModuleOptions): Promise<DataSource> {
  const {
    migrationsRun = false,
    assertMigrations = process.env.NODE_ENV !== 'development',
    ...dataSourceOptions
  } = options;

  const dataSource = createDataSource(dataSourceOptions);
  await dataSource.initialize();

  if (migrationsRun) await runMigrationsWithLock(dataSource);
  if (assertMigrations) await assertMigrationsUpToDate(dataSource);

  return dataSource;
}

@Global()
@Module({})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(MORTAR_DATA_SOURCE) private readonly dataSource: DataSource) {}

  static forRoot(options: DatabaseModuleOptions): DynamicModule {
    const dataSourceProvider: Provider = {
      provide: MORTAR_DATA_SOURCE,
      useFactory: (): Promise<DataSource> => initializeDataSource(options),
    };

    const serviceProvider: Provider = {
      provide: DatabaseService,
      useFactory: (dataSource: DataSource) => new DatabaseService(dataSource),
      inject: [MORTAR_DATA_SOURCE],
    };

    return {
      module: DatabaseModule,
      providers: [dataSourceProvider, serviceProvider],
      exports: [dataSourceProvider, serviceProvider],
    };
  }

  /**
   * Configures from other providers — validated config, most often.
   *
   * Without this a consumer must read `process.env` at import time, before
   * anything has validated it, which is precisely what the config layer
   * exists to prevent.
   */
  static forRootAsync(options: AsyncModuleOptions<DatabaseModuleOptions>): DynamicModule {
    const dataSourceProvider: Provider = {
      provide: MORTAR_DATA_SOURCE,
      useFactory: async (...args: never[]): Promise<DataSource> =>
        initializeDataSource(await options.useFactory(...args)),
      inject: (options.inject ?? []) as never[],
    };

    const serviceProvider: Provider = {
      provide: DatabaseService,
      useFactory: (dataSource: DataSource) => new DatabaseService(dataSource),
      inject: [MORTAR_DATA_SOURCE],
    };

    return {
      module: DatabaseModule,
      imports: (options.imports ?? []) as never[],
      providers: [dataSourceProvider, serviceProvider],
      exports: [dataSourceProvider, serviceProvider],
    };
  }

  /** Provides an already-initialized DataSource, for tests. */
  static forRootWithDataSource(dataSource: DataSource): DynamicModule {
    const providers: Provider[] = [
      { provide: MORTAR_DATA_SOURCE, useValue: dataSource },
      { provide: DatabaseService, useValue: new DatabaseService(dataSource) },
    ];
    return { module: DatabaseModule, providers, exports: providers };
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.dataSource.isInitialized) await this.dataSource.destroy();
  }
}
