import { runInContext } from '@mortar/context';
import { createTestDataSource, runInTransaction } from '@mortar/database';
import { ConflictError, ValidationError } from '@mortar/http';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IdempotencyRecord } from './entity';
import { IdempotencyService } from './service';
import { idempotencyMigrations } from './index';

let dataSource: DataSource;
let service: IdempotencyService;

const TENANT = '00000000-0000-0000-0000-0000000000aa';
const SCOPE = 'POST /orders';

beforeAll(async () => {
  dataSource = await createTestDataSource([IdempotencyRecord], {
    migrations: idempotencyMigrations,
  });
  service = new IdempotencyService(dataSource);
});

afterAll(async () => {
  if (dataSource?.isInitialized) await dataSource.destroy();
});

beforeEach(async () => {
  await dataSource.getRepository(IdempotencyRecord).clear();
});

describe('first request', () => {
  it('claims the key and tells the caller to proceed', async () => {
    const result = await service.begin('k1', SCOPE, { total: 100 });
    expect(result.outcome).toBe('proceed');
  });

  it('claims are visible immediately, before the caller commits anything', async () => {
    // The claim runs in its own transaction precisely so a concurrent
    // duplicate can see it. If it waited for the caller's transaction, two
    // simultaneous requests would both proceed.
    await runInTransaction(dataSource, async () => {
      await service.begin('k-visible', SCOPE, {});
      const seenFromOutside = await dataSource
        .getRepository(IdempotencyRecord)
        .findOneBy({ key: 'k-visible' });
      expect(seenFromOutside).not.toBeNull();
    });
  });
});

describe('replay', () => {
  it('returns the stored response for a repeat', async () => {
    const first = await service.begin('k2', SCOPE, { total: 100 });
    if (first.outcome !== 'proceed') throw new Error('expected proceed');
    await service.complete(first.record, 201, { id: 'order-1' });

    const second = await service.begin('k2', SCOPE, { total: 100 });
    expect(second).toEqual({ outcome: 'replay', status: 201, body: { id: 'order-1' } });
  });

  it('replays a null body without confusing it for "no response"', async () => {
    const first = await service.begin('k-null', SCOPE, {});
    if (first.outcome !== 'proceed') throw new Error('expected proceed');
    await service.complete(first.record, 204, null);

    const second = await service.begin('k-null', SCOPE, {});
    expect(second).toMatchObject({ outcome: 'replay', status: 204, body: null });
  });

  it('scopes keys per operation, so one key on two endpoints is two claims', async () => {
    const a = await service.begin('shared', 'POST /orders', { x: 1 });
    if (a.outcome !== 'proceed') throw new Error('expected proceed');
    await service.complete(a.record, 201, { from: 'orders' });

    const b = await service.begin('shared', 'POST /invoices', { x: 1 });
    expect(b.outcome).toBe('proceed');
  });

  it('scopes keys per tenant', async () => {
    await runInContext({ tenantId: TENANT }, async () => {
      const a = await service.begin('same', SCOPE, {});
      if (a.outcome !== 'proceed') throw new Error('expected proceed');
      await service.complete(a.record, 201, { tenant: 'a' });
    });
    await runInContext({ tenantId: '00000000-0000-0000-0000-0000000000bb' }, async () => {
      expect((await service.begin('same', SCOPE, {})).outcome).toBe('proceed');
    });
  });
});

describe('concurrency', () => {
  it('rejects a second request while the first is still running', async () => {
    await service.begin('k3', SCOPE, { total: 100 });
    await expect(service.begin('k3', SCOPE, { total: 100 })).rejects.toThrow(ConflictError);
  });

  it('lets exactly one of many simultaneous claims through', async () => {
    // The scenario every project in the catalogue actually hits: a guest
    // double-taps, or a flaky connection retries before the first response.
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, () => service.begin('stampede', SCOPE, { total: 1 })),
    );

    const proceeded = attempts.filter(
      (a) => a.status === 'fulfilled' && a.value.outcome === 'proceed',
    );
    expect(proceeded).toHaveLength(1);
    expect(await dataSource.getRepository(IdempotencyRecord).count()).toBe(1);
  });
});

describe('key reuse with a different payload', () => {
  it('is rejected rather than silently replaying the wrong answer', async () => {
    await service.begin('k4', SCOPE, { total: 100 });
    await expect(service.begin('k4', SCOPE, { total: 999 })).rejects.toThrow(ValidationError);
  });

  it('names the offending header and a machine-readable code', async () => {
    const first = await service.begin('k5', SCOPE, { a: 1 });
    if (first.outcome !== 'proceed') throw new Error('expected proceed');
    await service.complete(first.record, 200, {});

    // The client needs to know *which* header is wrong and *why*, not just
    // that something failed — this is a bug in their code, not a user error.
    const failure = await service.begin('k5', SCOPE, { a: 2 }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ValidationError);
    const problem = (failure as ValidationError).toProblemDetails();
    expect(problem.status).toBe(422);
    expect(problem.errors).toEqual([
      {
        field: 'Idempotency-Key',
        message: 'This idempotency key was already used with a different request payload.',
        code: 'idempotency_key_reused',
      },
    ]);
  });
});

describe('completion commits with the work', () => {
  it('does not mark the key completed when the work rolls back', async () => {
    const claim = await service.begin('k6', SCOPE, {});
    if (claim.outcome !== 'proceed') throw new Error('expected proceed');

    await expect(
      runInTransaction(dataSource, async () => {
        await service.complete(claim.record, 201, { id: 'x' });
        throw new Error('work failed after completing');
      }),
    ).rejects.toThrow('work failed');

    const record = await dataSource.getRepository(IdempotencyRecord).findOneByOrFail({ key: 'k6' });
    // Still in progress, so a retry can legitimately redo the work rather than
    // replaying a response for something that never committed.
    expect(record.status).toBe('in_progress');
  });

  it('marks it completed when the work commits', async () => {
    const claim = await service.begin('k7', SCOPE, {});
    if (claim.outcome !== 'proceed') throw new Error('expected proceed');

    await runInTransaction(dataSource, async () => {
      await service.complete(claim.record, 201, { id: 'y' });
    });

    const record = await dataSource.getRepository(IdempotencyRecord).findOneByOrFail({ key: 'k7' });
    expect(record.status).toBe('completed');
    expect(record.completedAt).not.toBeNull();
  });
});

describe('release', () => {
  it('frees the key so the client can retry', async () => {
    const claim = await service.begin('k8', SCOPE, {});
    if (claim.outcome !== 'proceed') throw new Error('expected proceed');

    await service.release(claim.record);

    expect((await service.begin('k8', SCOPE, {})).outcome).toBe('proceed');
  });

  it('survives the caller transaction rolling back around it', async () => {
    const claim = await service.begin('k9', SCOPE, {});
    if (claim.outcome !== 'proceed') throw new Error('expected proceed');

    await expect(
      runInTransaction(dataSource, async () => {
        await service.release(claim.record);
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');

    // The release ran independently, so the key is genuinely free.
    expect((await service.begin('k9', SCOPE, {})).outcome).toBe('proceed');
  });
});

describe('abandoned claims', () => {
  it('can be taken over after the lock timeout', async () => {
    // A process that dies mid-request would otherwise poison the key forever.
    const shortLock = new IdempotencyService(dataSource, { lockTimeoutMs: 50 });
    await shortLock.begin('k10', SCOPE, {});
    await expect(shortLock.begin('k10', SCOPE, {})).rejects.toThrow(ConflictError);

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect((await shortLock.begin('k10', SCOPE, {})).outcome).toBe('proceed');
  });
});

describe('expiry', () => {
  it('allows a fresh claim once the key has expired', async () => {
    const brief = new IdempotencyService(dataSource, { ttlMs: 50 });
    const first = await brief.begin('k11', SCOPE, {});
    if (first.outcome !== 'proceed') throw new Error('expected proceed');
    await brief.complete(first.record, 201, { id: 'old' });

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect((await brief.begin('k11', SCOPE, {})).outcome).toBe('proceed');
  });

  it('purges expired keys', async () => {
    const brief = new IdempotencyService(dataSource, { ttlMs: 10 });
    await brief.begin('k12', SCOPE, {});
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(await brief.purgeExpired()).toBe(1);
    expect(await dataSource.getRepository(IdempotencyRecord).count()).toBe(0);
  });
});
