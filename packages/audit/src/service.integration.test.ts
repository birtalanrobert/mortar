import { runInContext } from '@birtalanrobert/context';
import { createTestDataSource, runInTransaction } from '@birtalanrobert/database';
import { auditMigrations } from './index';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLogEntry } from './entity';
import { AuditService } from './service';

let dataSource: DataSource;
let audit: AuditService;

beforeAll(async () => {
  // Built by the real migration, not by synchronize — otherwise the
  // append-only trigger would not exist and the immutability test would be
  // asserting nothing.
  dataSource = await createTestDataSource([AuditLogEntry], { migrations: auditMigrations });
  audit = new AuditService(dataSource);
});

afterAll(async () => {
  if (dataSource?.isInitialized) await dataSource.destroy();
});

beforeEach(async () => {
  await dataSource.getRepository(AuditLogEntry).clear();
});

const count = () => dataSource.getRepository(AuditLogEntry).count();

describe('joining the caller transaction', () => {
  it('commits the audit row with the change it describes', async () => {
    await runInTransaction(dataSource, async () => {
      await audit.record({ action: 'booking.created', entityType: 'booking', entityId: 'b1' });
    });
    expect(await count()).toBe(1);
  });

  it('does NOT leave an audit row when the transaction rolls back', async () => {
    // The entire justification for adopting TypeORM and building the
    // transactional context: an audit row for a change that never happened is
    // worse than no row at all, because it is a confident record of a lie.
    await expect(
      runInTransaction(dataSource, async () => {
        await audit.record({ action: 'booking.created', entityType: 'booking', entityId: 'b1' });
        throw new Error('business rule failed');
      }),
    ).rejects.toThrow('business rule failed');

    expect(await count()).toBe(0);
  });

  it('writes directly when there is no transaction', async () => {
    await audit.record({ action: 'system.started' });
    expect(await count()).toBe(1);
  });

  it('is rolled back with an inner savepoint', async () => {
    await runInTransaction(dataSource, async () => {
      await audit.record({ action: 'outer.ok' });
      await expect(
        runInTransaction(dataSource, async () => {
          await audit.record({ action: 'inner.doomed' });
          throw new Error('inner failed');
        }),
      ).rejects.toThrow('inner failed');
    });

    const actions = (await dataSource.getRepository(AuditLogEntry).find()).map((e) => e.action);
    expect(actions).toEqual(['outer.ok']);
  });
});

describe('context capture', () => {
  it('takes tenant, actor, request and correlation from the ambient context', async () => {
    await runInContext(
      {
        requestId: 'req-1',
        correlationId: 'corr-1',
        tenantId: '00000000-0000-0000-0000-0000000000aa',
        actor: { id: 'u1', type: 'user', displayName: 'Ana Pop' },
        ip: '203.0.113.7',
        userAgent: 'Mozilla/5.0',
      },
      async () => {
        await audit.record({ action: 'invoice.issued', entityType: 'invoice', entityId: 'i1' });
      },
    );

    const entry = await dataSource
      .getRepository(AuditLogEntry)
      .findOneByOrFail({ action: 'invoice.issued' });
    expect(entry).toMatchObject({
      tenantId: '00000000-0000-0000-0000-0000000000aa',
      actorId: 'u1',
      actorType: 'user',
      actorName: 'Ana Pop',
      requestId: 'req-1',
      correlationId: 'corr-1',
      ip: '203.0.113.7',
    });
  });

  it('records both the impersonator and the impersonated actor', async () => {
    await runInContext(
      { actor: { id: 'u1', type: 'user', impersonatedBy: 'operator-7' } },
      async () => {
        await audit.record({ action: 'tenant.viewed' });
      },
    );
    const entry = await dataSource
      .getRepository(AuditLogEntry)
      .findOneByOrFail({ action: 'tenant.viewed' });
    expect(entry.actorId).toBe('u1');
    expect(entry.impersonatedBy).toBe('operator-7');
  });

  it('allows an explicit actor to override the context', async () => {
    await runInContext({ actor: { id: 'u1', type: 'user' } }, async () => {
      await audit.record({ action: 'job.ran', actor: { id: 'scheduler', type: 'system' } });
    });
    const entry = await dataSource
      .getRepository(AuditLogEntry)
      .findOneByOrFail({ action: 'job.ran' });
    expect(entry.actorId).toBe('scheduler');
  });

  it('permits a null tenant for platform-level actions', async () => {
    await audit.record({ action: 'platform.plan.changed', tenantId: null });
    const entry = await dataSource
      .getRepository(AuditLogEntry)
      .findOneByOrFail({ action: 'platform.plan.changed' });
    expect(entry.tenantId).toBeNull();
  });
});

describe('changes and metadata', () => {
  it('stores only what changed', async () => {
    await audit.record({
      action: 'employee.updated',
      before: { name: 'Ana', rate: 50 },
      after: { name: 'Ana', rate: 55 },
    });
    const entry = await dataSource
      .getRepository(AuditLogEntry)
      .findOneByOrFail({ action: 'employee.updated' });
    expect(entry.changes).toEqual({ rate: { from: 50, to: 55 } });
  });

  it('redacts secrets before they reach the database', async () => {
    await audit.record({
      action: 'user.password.changed',
      before: { passwordHash: 'old' },
      after: { passwordHash: 'new' },
      metadata: { token: 'super-secret-token', reason: 'reset' },
    });
    const entry = await dataSource
      .getRepository(AuditLogEntry)
      .findOneByOrFail({ action: 'user.password.changed' });
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain('super-secret-token');
    expect(serialized).not.toContain('old');
    expect(entry.metadata?.reason).toBe('reset');
  });
});

describe('immutability', () => {
  it('refuses an UPDATE at the database level', async () => {
    // The service exposes no update, but a trail that merely happens not to be
    // edited is worth less than one that cannot be.
    await audit.record({ action: 'original.action' });
    const entry = await dataSource
      .getRepository(AuditLogEntry)
      .findOneByOrFail({ action: 'original.action' });

    await expect(
      dataSource.query(`UPDATE mortar_audit_log SET action = 'tampered' WHERE id = $1`, [entry.id]),
    ).rejects.toThrow(/append-only/i);

    const after = await dataSource.getRepository(AuditLogEntry).findOneByOrFail({ id: entry.id });
    expect(after.action).toBe('original.action');
  });
});

describe('querying', () => {
  beforeEach(async () => {
    const tenant = '00000000-0000-0000-0000-0000000000bb';
    await runInContext({ tenantId: tenant, correlationId: 'c-1' }, async () => {
      await audit.record({ action: 'booking.created', entityType: 'booking', entityId: 'b1' });
      await audit.record({ action: 'booking.updated', entityType: 'booking', entityId: 'b1' });
    });
    await runInContext({ tenantId: tenant, correlationId: 'c-2' }, async () => {
      await audit.record({ action: 'booking.created', entityType: 'booking', entityId: 'b2' });
    });
  });

  it('returns an entity trail newest first', async () => {
    const trail = await audit.forEntity('booking', 'b1');
    expect(trail).toHaveLength(2);
    expect(trail[0]?.action).toBe('booking.updated');
  });

  it('groups one user action across services by correlation id', async () => {
    expect(await audit.forCorrelation('c-1')).toHaveLength(2);
  });

  it('filters by action and counts', async () => {
    expect(await audit.query({ action: 'booking.created' })).toHaveLength(2);
    expect(await audit.count({ entityType: 'booking' })).toBe(3);
  });

  it('caps the page size so one query cannot pull the whole table', async () => {
    const page = await audit.query({ limit: 10_000 });
    expect(page.length).toBeLessThanOrEqual(1000);
  });
});

describe('retention', () => {
  it('purges entries older than the cut-off and leaves newer ones', async () => {
    await audit.record({ action: 'old.action', occurredAt: new Date('2020-01-01T00:00:00Z') });
    await audit.record({ action: 'recent.action' });

    const deleted = await audit.purgeOlderThan(new Date('2021-01-01T00:00:00Z'));
    expect(deleted).toBe(1);

    const remaining = await dataSource.getRepository(AuditLogEntry).find();
    expect(remaining.map((e) => e.action)).toEqual(['recent.action']);
  });

  it('can be scoped to one tenant', async () => {
    const a = '00000000-0000-0000-0000-0000000000a1';
    const b = '00000000-0000-0000-0000-0000000000b1';
    const old = new Date('2020-01-01T00:00:00Z');
    await audit.record({ action: 'a.old', tenantId: a, occurredAt: old });
    await audit.record({ action: 'b.old', tenantId: b, occurredAt: old });

    await audit.purgeOlderThan(new Date('2021-01-01T00:00:00Z'), { tenantId: a });

    const remaining = await dataSource.getRepository(AuditLogEntry).find();
    expect(remaining.map((e) => e.action)).toEqual(['b.old']);
  });
});
