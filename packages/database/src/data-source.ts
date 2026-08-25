import { DataSource, type DataSourceOptions, type MixedList } from 'typeorm';
import { SnakeCaseNamingStrategy } from './naming';

export interface CreateDataSourceOptions {
  url: string;
  /** Entity classes or glob patterns. */
  entities?: MixedList<string | (new () => object)>;
  /** Migration classes or glob patterns. */
  migrations?: MixedList<string | (new () => object)>;
  poolSize?: number;
  connectTimeoutMs?: number;
  /**
   * Statement timeout. A query with no ceiling can hold a connection
   * indefinitely and take the pool with it; every project here would rather
   * fail one request than stall the service.
   */
  statementTimeoutMs?: number;
  ssl?: boolean;
  schema?: string;
  synchronize?: boolean;
  logging?: boolean;
  applicationName?: string;
  /** Escape hatch for anything not covered above. */
  extra?: Record<string, unknown>;
}

/**
 * Builds DataSource options with the conventions every project in the
 * catalogue shares, so that no project has to rediscover them.
 */
export function buildDataSourceOptions(options: CreateDataSourceOptions): DataSourceOptions {
  const {
    url,
    entities = [],
    migrations = [],
    poolSize = 10,
    connectTimeoutMs = 10_000,
    statementTimeoutMs = 30_000,
    ssl = false,
    schema = 'public',
    synchronize = false,
    logging = false,
    applicationName,
    extra = {},
  } = options;

  if (synchronize && process.env.NODE_ENV === 'production') {
    // synchronize drops columns it does not recognise. There is no situation
    // in which that is acceptable against production data.
    throw new Error('DATABASE_SYNCHRONIZE must never be enabled in production. Use migrations.');
  }

  return {
    type: 'postgres',
    url,
    schema,
    entities,
    migrations,
    synchronize,
    logging,
    // Migrations are run deliberately, by a command, so that a deploy that
    // fails to migrate fails visibly instead of half-migrating on boot across
    // several replicas at once.
    migrationsRun: false,
    namingStrategy: new SnakeCaseNamingStrategy(),
    poolSize,
    ssl: ssl ? { rejectUnauthorized: false } : false,
    extra: {
      connectionTimeoutMillis: connectTimeoutMs,
      statement_timeout: statementTimeoutMs,
      // Shows up in pg_stat_activity, which is how you find out which service
      // is holding the connection that is blocking everything else.
      application_name: applicationName,
      ...extra,
    },
  };
}

/** Creates an unconnected DataSource. Call `initialize()` to connect. */
export function createDataSource(options: CreateDataSourceOptions): DataSource {
  return new DataSource(buildDataSourceOptions(options));
}
