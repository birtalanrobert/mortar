import { describe, expect, it } from 'vitest';
import {
  contextSnapshot,
  getActor,
  getAttribute,
  getContext,
  getCorrelationId,
  getTenantId,
  requireContext,
  requireTenantId,
  runInChildContext,
  runInContext,
  setAttribute,
  setContextValues,
} from './index';

describe('context lifecycle', () => {
  it('is absent outside a run', () => {
    expect(getContext()).toBeUndefined();
    expect(getTenantId()).toBeUndefined();
  });

  it('is available inside a run', () => {
    runInContext({ tenantId: 't1', source: 'http' }, () => {
      expect(getContext()?.tenantId).toBe('t1');
      expect(getContext()?.source).toBe('http');
    });
  });

  it('generates a requestId and mirrors it into correlationId', () => {
    runInContext({}, () => {
      const context = requireContext();
      expect(context.requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(context.correlationId).toBe(context.requestId);
    });
  });

  it('honours an inbound correlationId', () => {
    runInContext({ correlationId: 'trace-abc' }, () => {
      expect(getCorrelationId()).toBe('trace-abc');
    });
  });

  it('does not leak between sibling runs', () => {
    runInContext({ tenantId: 'a' }, () => {
      expect(getTenantId()).toBe('a');
    });
    runInContext({ tenantId: 'b' }, () => {
      expect(getTenantId()).toBe('b');
    });
    expect(getTenantId()).toBeUndefined();
  });

  it('survives async boundaries', async () => {
    await runInContext({ tenantId: 'async-tenant' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(getTenantId()).toBe('async-tenant');
      await Promise.all([
        (async () => {
          await new Promise((resolve) => setImmediate(resolve));
          expect(getTenantId()).toBe('async-tenant');
        })(),
      ]);
    });
  });

  it('isolates concurrent runs from each other', async () => {
    const results = await Promise.all(
      ['t1', 't2', 't3'].map((tenantId) =>
        runInContext({ tenantId }, async () => {
          await new Promise((resolve) => setTimeout(resolve, Math.random() * 10));
          return getTenantId();
        }),
      ),
    );
    expect(results).toEqual(['t1', 't2', 't3']);
  });
});

describe('required accessors', () => {
  it('requireContext throws outside a run', () => {
    expect(() => requireContext()).toThrow(/No request context/);
  });

  it('requireTenantId throws when unscoped, rather than reading across tenants', () => {
    runInContext({}, () => {
      expect(() => requireTenantId()).toThrow(/No tenant is bound/);
    });
  });
});

describe('mutation during a request', () => {
  it('accepts the tenant and actor resolved mid-request', () => {
    runInContext({}, () => {
      setContextValues({ tenantId: 'resolved', actor: { id: 'u1', type: 'user' } });
      expect(getTenantId()).toBe('resolved');
      expect(getActor()?.id).toBe('u1');
    });
  });

  it('stores free-form attributes', () => {
    runInContext({}, () => {
      setAttribute('idempotencyKey', 'abc');
      expect(getAttribute<string>('idempotencyKey')).toBe('abc');
    });
  });

  it('ignores mutation outside a run rather than throwing', () => {
    expect(() => setContextValues({ tenantId: 'x' })).not.toThrow();
    expect(() => setAttribute('k', 1)).not.toThrow();
  });
});

describe('child contexts', () => {
  it('inherits correlation, tenant and actor so a job stays traceable', () => {
    runInContext(
      { correlationId: 'trace-1', tenantId: 't9', actor: { id: 'u2', type: 'user' } },
      () => {
        runInChildContext({ source: 'job' }, () => {
          expect(getCorrelationId()).toBe('trace-1');
          expect(getTenantId()).toBe('t9');
          expect(getActor()?.id).toBe('u2');
          expect(getContext()?.source).toBe('job');
          expect(getContext()?.requestId).not.toBe('trace-1');
        });
      },
    );
  });

  it('allows the child to override inherited values', () => {
    runInContext({ tenantId: 'parent' }, () => {
      runInChildContext({ tenantId: 'child' }, () => {
        expect(getTenantId()).toBe('child');
      });
    });
  });
});

describe('contextSnapshot', () => {
  it('is empty outside a run', () => {
    expect(contextSnapshot()).toEqual({});
  });

  it('includes only the fields that are set', () => {
    runInContext({ correlationId: 'c1', requestId: 'r1', source: 'http' }, () => {
      expect(contextSnapshot()).toEqual({
        requestId: 'r1',
        correlationId: 'c1',
        source: 'http',
      });
    });
  });

  it('surfaces impersonation, which the audit trail must record', () => {
    runInContext({ actor: { id: 'u1', type: 'user', impersonatedBy: 'operator-7' } }, () => {
      expect(contextSnapshot()).toMatchObject({
        actorId: 'u1',
        impersonatedBy: 'operator-7',
      });
    });
  });
});
