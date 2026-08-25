import { RedisLocks, createTestRedis, flushTestRedis } from '@birtalanrobert/redis';
import type { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { WindowScanner } from './scanner';

interface Reminder {
  id: string;
  dueAt: Date;
  kind: '24h' | '2h';
}

const client: Redis = createTestRedis('scanner-suite');
const locks = new RedisLocks(client);

afterAll(async () => {
  await flushTestRedis(client);
  await client.quit();
});

beforeEach(async () => {
  await flushTestRedis(client);
});

function scanner(
  items: Reminder[],
  dispatched: string[],
  overrides: Partial<ConstructorParameters<typeof WindowScanner<Reminder>>[0]> = {},
) {
  return new WindowScanner<Reminder>(
    {
      name: `reminders-${Math.random().toString(36).slice(2, 8)}`,
      intervalMs: 1000,
      windowMs: 15 * 60 * 1000,
      find: async (from, to) => items.filter((item) => item.dueAt >= from && item.dueAt < to),
      // The key includes *which* reminder, not just the booking — otherwise
      // the 24-hour and 2-hour reminders collapse into one.
      keyFor: (item) => `${item.id}:${item.kind}`,
      dispatch: async (item) => void dispatched.push(`${item.id}:${item.kind}`),
      ...overrides,
    },
    locks,
  );
}

const inMinutes = (n: number) => new Date(Date.now() + n * 60_000);

describe('finding work', () => {
  it('dispatches items falling inside the window', async () => {
    const sent: string[] = [];
    const result = await scanner(
      [
        { id: 'b1', dueAt: inMinutes(5), kind: '2h' },
        { id: 'b2', dueAt: inMinutes(10), kind: '2h' },
      ],
      sent,
    ).scanOnce();

    expect(result.dispatched).toBe(2);
    expect(sent.sort()).toEqual(['b1:2h', 'b2:2h']);
  });

  it('ignores items beyond the window', async () => {
    const sent: string[] = [];
    await scanner([{ id: 'far', dueAt: inMinutes(60), kind: '2h' }], sent).scanOnce();
    expect(sent).toEqual([]);
  });

  it('ignores items already past', async () => {
    const sent: string[] = [];
    await scanner([{ id: 'gone', dueAt: inMinutes(-5), kind: '2h' }], sent).scanOnce();
    expect(sent).toEqual([]);
  });
});

describe('overlapping scans', () => {
  it('dispatches each item once across repeated passes', async () => {
    // The overlap between window and interval is deliberate, so the same item
    // is found repeatedly; the claim is what stops it being sent twice.
    const sent: string[] = [];
    const s = scanner([{ id: 'b1', dueAt: inMinutes(5), kind: '2h' }], sent);

    await s.scanOnce();
    await s.scanOnce();
    await s.scanOnce();

    expect(sent).toEqual(['b1:2h']);
  });

  it('reports the repeats as skipped rather than pretending they were new', async () => {
    const sent: string[] = [];
    const s = scanner([{ id: 'b1', dueAt: inMinutes(5), kind: '2h' }], sent);
    await s.scanOnce();
    const second = await s.scanOnce();
    expect(second.found).toBe(1);
    expect(second.dispatched).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it('keeps distinct reminders for one booking separate', async () => {
    const sent: string[] = [];
    await scanner(
      [
        { id: 'b1', dueAt: inMinutes(5), kind: '24h' },
        { id: 'b1', dueAt: inMinutes(6), kind: '2h' },
      ],
      sent,
    ).scanOnce();
    expect(sent.sort()).toEqual(['b1:24h', 'b1:2h']);
  });
});

describe('self-correction — why scanning beats one job per item', () => {
  it('does not dispatch for an item that was cancelled', async () => {
    // The failure every spec warns about: a scheduled per-item job still fires
    // for an appointment that no longer exists.
    const items: Reminder[] = [{ id: 'b1', dueAt: inMinutes(5), kind: '2h' }];
    const sent: string[] = [];
    const s = scanner(items, sent);

    items.length = 0; // cancelled between scans
    await s.scanOnce();

    expect(sent).toEqual([]);
  });

  it('follows an item that was rescheduled out of the window', async () => {
    const items: Reminder[] = [{ id: 'b1', dueAt: inMinutes(5), kind: '2h' }];
    const sent: string[] = [];
    const s = scanner(items, sent);

    items[0]!.dueAt = inMinutes(90); // moved to next week, in effect
    await s.scanOnce();

    // Nothing to un-schedule, because nothing was scheduled.
    expect(sent).toEqual([]);
  });
});

describe('failure handling', () => {
  it('retries on the next pass when a dispatch fails', async () => {
    const attempts: string[] = [];
    let failFirst = true;

    const s = new WindowScanner<Reminder>(
      {
        name: `retry-${Math.random().toString(36).slice(2, 8)}`,
        intervalMs: 1000,
        windowMs: 60_000,
        find: async () => [{ id: 'b1', dueAt: inMinutes(0.5), kind: '2h' }],
        keyFor: (item) => `${item.id}:${item.kind}`,
        dispatch: async (item) => {
          attempts.push(item.id);
          if (failFirst) {
            failFirst = false;
            throw new Error('sms provider unavailable');
          }
        },
      },
      locks,
    );

    const first = await s.scanOnce();
    expect(first.failed).toBe(1);

    // The claim was released, so the item is genuinely retried rather than
    // silently dropped.
    const second = await s.scanOnce();
    expect(second.dispatched).toBe(1);
    expect(attempts).toEqual(['b1', 'b1']);
  });

  it('survives the query itself failing', async () => {
    const s = new WindowScanner<Reminder>(
      {
        name: `broken-${Math.random().toString(36).slice(2, 8)}`,
        intervalMs: 1000,
        windowMs: 60_000,
        find: async () => {
          throw new Error('database unavailable');
        },
        keyFor: (item) => item.id,
        dispatch: async () => undefined,
      },
      locks,
    );

    // A scanner that dies stops silently, and the first anyone hears is a
    // customer asking why they were never reminded.
    await expect(s.scanOnce()).resolves.toMatchObject({ found: 0, dispatched: 0 });
  });
});

describe('running on a fleet', () => {
  it('scans once when several replicas scan together', async () => {
    const sent: string[] = [];
    const items = [{ id: 'b1', dueAt: inMinutes(5), kind: '2h' as const }];
    const name = `fleet-${Math.random().toString(36).slice(2, 8)}`;

    const replicas = Array.from(
      { length: 4 },
      () =>
        new WindowScanner<Reminder>(
          {
            name,
            intervalMs: 1000,
            windowMs: 15 * 60 * 1000,
            find: async (from, to) => items.filter((i) => i.dueAt >= from && i.dueAt < to),
            keyFor: (item) => `${item.id}:${item.kind}`,
            dispatch: async (item) => void sent.push(item.id),
          },
          locks,
        ),
    );

    const results = await Promise.all(replicas.map((r) => r.scanOnce()));

    expect(sent).toEqual(['b1']);
    expect(results.filter((r) => r.dispatched > 0)).toHaveLength(1);
  });
});

describe('configuration', () => {
  it('refuses a window that does not exceed the interval', () => {
    // Otherwise a late scan leaves a gap in which an item's moment passes
    // unnoticed — the exact hole the overlap exists to close.
    expect(
      () =>
        new WindowScanner<Reminder>(
          {
            name: 'bad',
            intervalMs: 60_000,
            windowMs: 60_000,
            find: async () => [],
            keyFor: (i) => i.id,
            dispatch: async () => undefined,
          },
          locks,
        ),
    ).toThrow(/must exceed intervalMs/);
  });
});
