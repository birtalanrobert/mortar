import { runInContext } from '@birtalanrobert/context';
import { createTestDataSource, runInTransaction } from '@birtalanrobert/database';
import { CrossTenantAccessError } from '@birtalanrobert/http';
import { Column, DataSource, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TenantScopedRepository } from './repository';
import {
  assertRlsEffective,
  checkRlsEffective,
  currentBoundTenant,
  enableRlsSql,
  runInTenantTransaction,
} from './rls';

@Entity({ name: 'tenancy_test_note' })
class Note {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  tenantId!: string;

  @Column({ type: 'text' })
  body!: string;
}

const TENANT_A = '00000000-0000-0000-0000-00000000000a';
const TENANT_B = '00000000-0000-0000-0000-00000000000b';

let dataSource: DataSource;
let notes: TenantScopedRepository<Note>;

beforeAll(async () => {
  dataSource = await createTestDataSource([Note]);
  notes = new TenantScopedRepository(dataSource, Note);
});

afterAll(async () => {
  if (dataSource?.isInitialized) await dataSource.destroy();
});

beforeEach(async () => {
  await dataSource.getRepository(Note).clear();
  await dataSource.getRepository(Note).save([
    { tenantId: TENANT_A, body: 'a-one' },
    { tenantId: TENANT_A, body: 'a-two' },
    { tenantId: TENANT_B, body: 'b-one' },
  ]);
});

const asTenant = <T>(tenantId: string, work: () => Promise<T>): Promise<T> =>
  runInContext({ tenantId }, work);

describe('reads are scoped', () => {
  it('returns only the caller tenant rows', async () => {
    const rows = await asTenant(TENANT_A, () => notes.find());
    expect(rows.map((n) => n.body).sort()).toEqual(['a-one', 'a-two']);
  });

  it('counts only the caller tenant rows', async () => {
    expect(await asTenant(TENANT_A, () => notes.count())).toBe(2);
    expect(await asTenant(TENANT_B, () => notes.count())).toBe(1);
  });

  it('cannot reach another tenant row by id', async () => {
    const other = await dataSource.getRepository(Note).findOneByOrFail({ body: 'b-one' });
    expect(await asTenant(TENANT_A, () => notes.findById(other.id))).toBeNull();
  });

  it('cannot widen the scope by passing tenantId in the filter', async () => {
    // The scoped predicate is applied last and overwrites anything the caller
    // supplied, so a hand-written tenantId cannot escape the boundary.
    const rows = await asTenant(TENANT_A, () =>
      notes.find({ where: { tenantId: TENANT_B } as never }),
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((n) => n.tenantId === TENANT_A)).toBe(true);
  });

  it('scopes every clause of an OR filter', async () => {
    const rows = await asTenant(TENANT_A, () =>
      notes.find({ where: [{ body: 'a-one' }, { body: 'b-one' }] as never }),
    );
    expect(rows.map((n) => n.body)).toEqual(['a-one']);
  });

  it('scopes the query builder', async () => {
    const rows = await asTenant(TENANT_A, async () => notes.createQueryBuilder('n').getMany());
    expect(rows).toHaveLength(2);
  });
});

describe('writes are scoped', () => {
  it('stamps the tenant on create', async () => {
    const note = await asTenant(TENANT_A, async () => notes.save({ body: 'new' }));
    expect(note.tenantId).toBe(TENANT_A);
  });

  it('refuses to save a row belonging to another tenant', async () => {
    await expect(
      asTenant(TENANT_A, () => notes.save({ tenantId: TENANT_B, body: 'smuggled' } as never)),
    ).rejects.toThrow(CrossTenantAccessError);
  });

  it('cannot move a row to another tenant via update', async () => {
    const mine = await dataSource.getRepository(Note).findOneByOrFail({ body: 'a-one' });
    await asTenant(TENANT_A, () =>
      notes.update({ id: mine.id } as never, { tenantId: TENANT_B, body: 'edited' } as never),
    );
    const after = await dataSource.getRepository(Note).findOneByOrFail({ id: mine.id });
    expect(after.tenantId).toBe(TENANT_A);
    expect(after.body).toBe('edited');
  });

  it('cannot update another tenant row', async () => {
    const other = await dataSource.getRepository(Note).findOneByOrFail({ body: 'b-one' });
    const affected = await asTenant(TENANT_A, () =>
      notes.update({ id: other.id } as never, { body: 'hacked' } as never),
    );
    expect(affected).toBe(0);
    const after = await dataSource.getRepository(Note).findOneByOrFail({ id: other.id });
    expect(after.body).toBe('b-one');
  });

  it('cannot delete another tenant row', async () => {
    const other = await dataSource.getRepository(Note).findOneByOrFail({ body: 'b-one' });
    expect(await asTenant(TENANT_A, () => notes.delete({ id: other.id } as never))).toBe(0);
    expect(await dataSource.getRepository(Note).countBy({ id: other.id })).toBe(1);
  });
});

describe('unscoped access must be deliberate', () => {
  it('throws when no tenant is bound, rather than reading everything', async () => {
    // The single most important behaviour in this package: an unscoped query
    // must fail loudly, never quietly return every tenant's rows.
    await expect(notes.find()).rejects.toThrow(/No tenant is bound/);
  });

  it('permits an explicit escape with a substantive reason', async () => {
    const all = await asTenant(TENANT_A, () =>
      notes.unscoped('platform-wide nightly usage metering', (repo) => repo.find()),
    );
    expect(all).toHaveLength(3);
  });

  it('rejects a token reason, so the audit trail stays meaningful', async () => {
    await expect(
      asTenant(TENANT_A, () => notes.unscoped('x', (repo) => repo.find())),
    ).rejects.toThrow(/substantive reason/);
  });
});

describe('row-level security', () => {
  // RLS is exercised through a dedicated non-superuser role, because Postgres
  // superusers bypass every policy — FORCE included. The default test role is
  // a superuser, so running these assertions on it would prove nothing while
  // appearing to pass.
  let appDataSource: DataSource;

  beforeAll(async () => {
    await dataSource.query(`DROP OWNED BY rls_app_role`).catch(() => undefined);
    await dataSource.query(`DROP ROLE IF EXISTS rls_app_role`);
    await dataSource.query(
      `CREATE ROLE rls_app_role LOGIN PASSWORD 'rls_app_role' NOSUPERUSER NOBYPASSRLS`,
    );
    await dataSource.query(`GRANT USAGE ON SCHEMA public TO rls_app_role`);
    await dataSource.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON tenancy_test_note TO rls_app_role`,
    );

    for (const statement of enableRlsSql('tenancy_test_note')) {
      await dataSource.query(statement);
    }

    appDataSource = new DataSource({
      type: 'postgres',
      url: 'postgres://rls_app_role:rls_app_role@localhost:3050/mortar_test',
      entities: [Note],
      synchronize: false,
    });
    await appDataSource.initialize();
  });

  afterAll(async () => {
    if (appDataSource?.isInitialized) await appDataSource.destroy();
    await dataSource.query('ALTER TABLE tenancy_test_note NO FORCE ROW LEVEL SECURITY');
    await dataSource.query('ALTER TABLE tenancy_test_note DISABLE ROW LEVEL SECURITY');
    await dataSource
      .query(`REVOKE ALL ON tenancy_test_note FROM rls_app_role`)
      .catch(() => undefined);
    await dataSource
      .query(`REVOKE USAGE ON SCHEMA public FROM rls_app_role`)
      .catch(() => undefined);
    await dataSource.query(`DROP ROLE IF EXISTS rls_app_role`).catch(() => undefined);
  });

  it('reports that RLS cannot apply to a superuser connection', async () => {
    // The trap this check exists for: an application connecting as a superuser
    // gets zero isolation, every policy is decorative, and nothing warns.
    const result = await checkRlsEffective(dataSource);
    expect(result.effective).toBe(false);
    expect(result.isSuperuser).toBe(true);
    expect(result.reason).toMatch(/superuser/i);
    await expect(assertRlsEffective(dataSource)).rejects.toThrow(/not effective/i);
  });

  it('reports that RLS applies to an ordinary application role', async () => {
    const result = await checkRlsEffective(appDataSource);
    expect(result.effective).toBe(true);
    expect(result.role).toBe('rls_app_role');
  });

  it('binds the tenant inside the transaction', async () => {
    await runInTenantTransaction(
      appDataSource,
      async (manager) => {
        expect(await currentBoundTenant(manager)).toBe(TENANT_A);
      },
      { tenantId: TENANT_A },
    );
  });

  it('hides other tenants rows even from a raw unscoped query', async () => {
    // Defence in depth: the repository stops an unscoped query being written;
    // RLS stops one returning foreign rows if it is written anyway — through
    // raw SQL, a query builder, or a third-party library.
    await runInTenantTransaction(
      appDataSource,
      async (manager) => {
        const rows = (await manager.query('SELECT body FROM tenancy_test_note')) as Array<{
          body: string;
        }>;
        expect(rows.map((r) => r.body).sort()).toEqual(['a-one', 'a-two']);
      },
      { tenantId: TENANT_A },
    );
  });

  it('refuses an insert for a different tenant', async () => {
    await expect(
      runInTenantTransaction(
        appDataSource,
        async (manager) => {
          await manager.query('INSERT INTO tenancy_test_note (tenant_id, body) VALUES ($1, $2)', [
            TENANT_B,
            'smuggled',
          ]);
        },
        { tenantId: TENANT_A },
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('returns nothing at all when no tenant is bound', async () => {
    // current_setting(..., true) yields NULL, so the policy matches no row —
    // failing closed rather than open.
    await runInTransaction(appDataSource, async (manager) => {
      const rows = (await manager.query('SELECT body FROM tenancy_test_note')) as unknown[];
      expect(rows).toHaveLength(0);
    });
  });

  it('does not leak the binding to the next transaction on the same connection', async () => {
    // SET LOCAL is transaction-scoped. If it were not, a pooled connection
    // would carry one tenant's binding into the next request.
    await runInTenantTransaction(appDataSource, async () => undefined, { tenantId: TENANT_A });
    await runInTransaction(appDataSource, async (manager) => {
      expect(await currentBoundTenant(manager)).toBeUndefined();
    });
  });
});
