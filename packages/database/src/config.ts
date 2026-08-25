import { envBoolean, envDuration, envInt, envString, envUrl, z } from '@mortar/config';

/**
 * The database variables every service in the catalogue needs.
 *
 * Composed into an application's own schema:
 *
 *   const schema = baseEnvSchema.merge(databaseEnvSchema).extend({ ... });
 */
export const databaseEnvSchema = z.object({
  DATABASE_URL: envUrl(),
  /**
   * Pool size. The default is deliberately modest: Postgres handles a small
   * busy pool far better than a large idle one, and every project in this
   * catalogue runs several processes (api, worker) against one database.
   */
  DATABASE_POOL_SIZE: envInt(10),
  DATABASE_CONNECT_TIMEOUT: envDuration(10_000),
  DATABASE_STATEMENT_TIMEOUT: envDuration(30_000),
  DATABASE_SSL: envBoolean(false),
  /**
   * Never true in production. Migrations are the only supported way to change
   * a schema; synchronize silently drops columns.
   */
  DATABASE_SYNCHRONIZE: envBoolean(false),
  DATABASE_LOGGING: envBoolean(false),
  DATABASE_SCHEMA: envString('public'),
});

export type DatabaseEnv = z.infer<typeof databaseEnvSchema>;
