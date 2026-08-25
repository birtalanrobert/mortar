import { runInTransaction, type TransactionOptions } from '@mortar/database';
import { requireTenantId } from '@mortar/context';
import type { DataSource, EntityManager, QueryRunner } from 'typeorm';

/** The Postgres session variable RLS policies read. */
export const TENANT_SETTING = 'mortar.tenant_id';

/**
 * Binds the tenant to the transaction's own connection.
 *
 * `SET LOCAL` is scoped to the current transaction and to the connection
 * running it. That is exactly why this must happen *inside* the transaction
 * and on its query runner: a value set on a different pooled connection
 * applies to nothing, and a value set without `LOCAL` would leak to whatever
 * request picks that connection up next — which in a multi-tenant system means
 * serving one tenant's rows to another.
 */
export async function bindTenantToTransaction(
  queryRunner: QueryRunner,
  tenantId: string,
): Promise<void> {
  // set_config's third argument is is_local; parameterised rather than
  // interpolated, because SET LOCAL does not accept bind parameters directly.
  await queryRunner.query(`SELECT set_config($1, $2, true)`, [TENANT_SETTING, tenantId]);
}

/** Reads the tenant currently bound to this connection. Diagnostic use. */
export async function currentBoundTenant(manager: EntityManager): Promise<string | undefined> {
  const rows = (await manager.query(`SELECT current_setting($1, true) AS tenant_id`, [
    TENANT_SETTING,
  ])) as Array<{ tenant_id: string | null }>;
  return rows[0]?.tenant_id || undefined;
}

/**
 * Runs work in a transaction with the tenant bound for row-level security.
 *
 * This is the safety net beneath the scoped repository, not a replacement for
 * it. The repository prevents an unscoped query from being *written*; RLS
 * prevents one from *returning another tenant's rows* if it is written anyway
 * — through raw SQL, a query builder, a third-party library, or a mistake.
 * Defence in depth, because a single missed `WHERE tenant_id = …` in a
 * multi-tenant system is a data breach rather than a bug.
 */
export async function runInTenantTransaction<T>(
  dataSource: DataSource,
  work: (manager: EntityManager) => Promise<T>,
  options: TransactionOptions & { tenantId?: string } = {},
): Promise<T> {
  const tenantId = options.tenantId ?? requireTenantId();

  return runInTransaction(dataSource, work, {
    ...options,
    onBegin: async (queryRunner) => {
      await bindTenantToTransaction(queryRunner, tenantId);
      if (options.onBegin) await options.onBegin(queryRunner);
    },
  });
}

/**
 * SQL enabling RLS on a table and adding the standard tenant policy.
 *
 * Emitted by migrations rather than executed here, so the policy lives in the
 * schema history where it can be reviewed and rolled back.
 *
 * `FORCE ROW LEVEL SECURITY` matters: without it, the table's owner bypasses
 * every policy — and the application role is very often also the owner in the
 * deployments these projects run on, which would make the whole thing
 * decorative.
 */
export function enableRlsSql(table: string, tenantColumn = 'tenant_id'): string[] {
  const policy = `${table}_tenant_isolation`;
  return [
    `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`,
    `DROP POLICY IF EXISTS "${policy}" ON "${table}"`,
    `CREATE POLICY "${policy}" ON "${table}"
       USING ("${tenantColumn}"::text = current_setting('${TENANT_SETTING}', true))
       WITH CHECK ("${tenantColumn}"::text = current_setting('${TENANT_SETTING}', true))`,
  ];
}

/** SQL removing the policy again, for a migration's `down`. */
export function disableRlsSql(table: string): string[] {
  return [
    `DROP POLICY IF EXISTS "${table}_tenant_isolation" ON "${table}"`,
    `ALTER TABLE "${table}" NO FORCE ROW LEVEL SECURITY`,
    `ALTER TABLE "${table}" DISABLE ROW LEVEL SECURITY`,
  ];
}

export interface RlsEffectiveness {
  readonly effective: boolean;
  readonly reason?: string;
  readonly role: string;
  readonly isSuperuser: boolean;
  readonly bypassRls: boolean;
}

/**
 * Verifies that row-level security can actually apply to the connecting role.
 *
 * This exists because RLS fails **silently and completely** in two very
 * ordinary configurations:
 *
 * - The role is a **superuser**. Superusers bypass every policy, always, and
 *   `FORCE ROW LEVEL SECURITY` does not change that.
 * - The role has **BYPASSRLS**.
 *
 * In either case every policy is decorative, every query returns every
 * tenant's rows, and nothing anywhere reports a problem. Development databases
 * are very often created with a superuser, so an application can pass its
 * entire test suite with RLS doing nothing.
 *
 * Call this at boot in any environment that relies on RLS, and refuse to start
 * if it is not effective.
 */
export async function checkRlsEffective(dataSource: DataSource): Promise<RlsEffectiveness> {
  const rows = (await dataSource.query(
    `SELECT current_user AS role, rolsuper, rolbypassrls
       FROM pg_roles WHERE rolname = current_user`,
  )) as Array<{ role: string; rolsuper: boolean; rolbypassrls: boolean }>;

  const row = rows[0];
  if (!row) {
    return {
      effective: false,
      reason: 'Could not determine the current role.',
      role: 'unknown',
      isSuperuser: false,
      bypassRls: false,
    };
  }

  if (row.rolsuper) {
    return {
      effective: false,
      reason: `Role '${row.role}' is a superuser and bypasses all row-level security policies. Connect as a non-superuser role.`,
      role: row.role,
      isSuperuser: true,
      bypassRls: false,
    };
  }

  if (row.rolbypassrls) {
    return {
      effective: false,
      reason: `Role '${row.role}' has BYPASSRLS and is exempt from all policies.`,
      role: row.role,
      isSuperuser: false,
      bypassRls: true,
    };
  }

  return { effective: true, role: row.role, isSuperuser: false, bypassRls: false };
}

/** Throws unless row-level security can apply. Call at boot. */
export async function assertRlsEffective(dataSource: DataSource): Promise<void> {
  const result = await checkRlsEffective(dataSource);
  if (!result.effective) {
    throw new Error(
      `Row-level security is not effective for this connection: ${result.reason} ` +
        `Every tenant isolation policy would be silently ignored.`,
    );
  }
}
