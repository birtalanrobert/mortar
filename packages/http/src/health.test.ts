import { describe, expect, it } from 'vitest';
import { HealthRegistry, createIndicator, type IndicatorResult } from './health';

const up = (): Promise<IndicatorResult> => Promise.resolve({ status: 'up' });
const down = (): Promise<IndicatorResult> =>
  Promise.resolve({ status: 'down', error: 'unreachable' });
const degraded = (): Promise<IndicatorResult> => Promise.resolve({ status: 'degraded' });

describe('HealthRegistry', () => {
  it('reports up when everything is up', async () => {
    const registry = new HealthRegistry()
      .register(createIndicator('database', up))
      .register(createIndicator('redis', up));
    const report = await registry.check();
    expect(report.status).toBe('up');
    expect(Object.keys(report.checks).sort()).toEqual(['database', 'redis']);
  });

  it('reports down when a critical dependency is down', async () => {
    const registry = new HealthRegistry().register(createIndicator('database', down));
    expect((await registry.check()).status).toBe('down');
  });

  it('reports degraded, not down, when only a non-critical dependency fails', async () => {
    // Taking a service out of rotation because its metrics sink is unreachable
    // turns a cosmetic problem into an outage.
    const registry = new HealthRegistry()
      .register(createIndicator('database', up))
      .register(createIndicator('metrics', down, false));
    const report = await registry.check();
    expect(report.status).toBe('degraded');
    expect(report.checks.metrics?.status).toBe('down');
  });

  it('reports degraded when an indicator says so', async () => {
    const registry = new HealthRegistry().register(createIndicator('queue', degraded));
    expect((await registry.check()).status).toBe('degraded');
  });

  it('treats a throwing indicator as down rather than failing the endpoint', async () => {
    const registry = new HealthRegistry().register(
      createIndicator('exploding', () => {
        throw new Error('kaboom');
      }),
    );
    const report = await registry.check();
    expect(report.status).toBe('down');
    expect(report.checks.exploding?.error).toBe('kaboom');
  });

  it('bounds a hanging indicator with a timeout', async () => {
    // The failure this endpoint most needs to survive is a dependency that
    // hangs, not one that errors.
    const registry = new HealthRegistry().register(
      createIndicator('hanging', () => new Promise<IndicatorResult>(() => undefined)),
    );
    const report = await registry.check(50);
    expect(report.status).toBe('down');
    expect(report.checks.hanging?.error).toMatch(/timed out after 50ms/);
  });

  it('runs indicators in parallel', async () => {
    const slow = () =>
      new Promise<IndicatorResult>((resolve) => setTimeout(() => resolve({ status: 'up' }), 60));
    const registry = new HealthRegistry()
      .register(createIndicator('a', slow))
      .register(createIndicator('b', slow))
      .register(createIndicator('c', slow));
    const startedAt = Date.now();
    await registry.check();
    expect(Date.now() - startedAt).toBeLessThan(150);
  });

  it('reports up with no indicators registered', async () => {
    expect((await new HealthRegistry().check()).status).toBe('up');
  });

  it('supports registering and unregistering', async () => {
    const registry = new HealthRegistry().register(createIndicator('temp', down));
    expect((await registry.check()).status).toBe('down');
    registry.unregister('temp');
    expect((await registry.check()).status).toBe('up');
    expect(registry.list()).toHaveLength(0);
  });

  it('measures its own duration', async () => {
    const report = await new HealthRegistry().register(createIndicator('a', up)).check();
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });
});
