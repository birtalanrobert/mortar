import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskScheduler } from './scheduler';
import type { AcquiredLock, RedisLocks } from '@birtalanrobert/redis';

const claimed = (key: string): AcquiredLock => ({
  key,
  token: 't',
  release: async () => true,
  extend: async () => true,
});

/** A lock that behaves however the test needs it to; every interval is unclaimed. */
const locks = (withLock: RedisLocks['withLock']): RedisLocks =>
  ({ withLock, acquire: async (key: string) => claimed(key) }) as unknown as RedisLocks;

/**
 * Redis's locks, in memory and on the test's clock: a key is held until it is
 * released or its time runs out. Shared by several schedulers, it is a fleet.
 */
const memoryLocks = (): RedisLocks => {
  const held = new Map<string, { token: string; until: number }>();
  let tokens = 0;

  const acquire = async (key: string, options: { ttlMs?: number } = {}) => {
    const current = held.get(key);
    if (current && current.until > Date.now()) return null;
    const token = String((tokens += 1));
    held.set(key, { token, until: Date.now() + (options.ttlMs ?? 30_000) });
    return {
      key,
      token,
      release: async () => held.get(key)?.token === token && held.delete(key),
      extend: async () => true,
    };
  };

  const withLock = async <T>(
    key: string,
    work: () => Promise<T>,
    options?: { ttlMs?: number },
  ): Promise<T | undefined> => {
    const lock = await acquire(key, options);
    if (!lock) return undefined;
    try {
      return await work();
    } finally {
      await lock.release();
    }
  };

  return { acquire, withLock } as unknown as RedisLocks;
};

const silent = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
};

describe('TaskScheduler', () => {
  it('runs a task on start when asked to', async () => {
    const run = vi.fn().mockResolvedValue(undefined);

    new TaskScheduler(
      locks(async (_key, work) => work()),
      silent as never,
    ).register({ name: 'sweep', intervalMs: 60_000, run, runOnStart: true });

    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  });

  /**
   * The failure that took a process down.
   *
   * A task's own throw has always been swallowed; **taking the lock** was
   * outside that guard, so a Redis connection closing — during a shutdown, a
   * restart, a network blip — became an unhandled rejection out of an interval
   * callback. A seed script exited non-zero about one run in three because of
   * it, and a deploy step that fails intermittently is one somebody makes
   * non-blocking.
   */
  it('survives a lock it cannot take', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);

    try {
      const logger = { ...silent, error: vi.fn() };

      new TaskScheduler(
        locks(async () => {
          throw new Error('Connection is closed.');
        }),
        logger as never,
      ).register({ name: 'sweep', intervalMs: 60_000, run: vi.fn(), runOnStart: true });

      await vi.waitFor(() => expect(logger.error).toHaveBeenCalled());
      /* A tick that could not be taken, said once and then left alone. */
      expect(logger.error.mock.calls[0]?.[0]).toContain('could not take its lock');

      /* And nothing escaped to the process, which is the point. */
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('still swallows what the task itself throws', async () => {
    const logger = { ...silent, error: vi.fn() };

    new TaskScheduler(
      locks(async (_key, work) => work()),
      logger as never,
    ).register({
      name: 'sweep',
      intervalMs: 60_000,
      run: () => Promise.reject(new Error('the report failed')),
      runOnStart: true,
    });

    await vi.waitFor(() => expect(logger.error).toHaveBeenCalled());
    expect(logger.error.mock.calls[0]?.[0]).toContain('scheduled task failed');
  });

  it('says nothing but a debug line when another replica holds it', async () => {
    const logger = { ...silent, debug: vi.fn() };

    new TaskScheduler(
      locks(async () => undefined),
      logger as never,
    ).register({ name: 'sweep', intervalMs: 60_000, run: vi.fn(), runOnStart: true });

    await vi.waitFor(() => expect(logger.debug).toHaveBeenCalled());
  });

  it('refuses two tasks with one name', () => {
    const scheduler = new TaskScheduler(
      locks(async (_key, work) => work()),
      silent as never,
    );

    scheduler.register({ name: 'sweep', intervalMs: 60_000, run: vi.fn() });

    expect(() => scheduler.register({ name: 'sweep', intervalMs: 60_000, run: vi.fn() })).toThrow(
      /already registered/,
    );
  });

  it('refuses an interval that is not a whole, positive number of milliseconds', () => {
    const scheduler = new TaskScheduler(
      locks(async (_key, work) => work()),
      silent as never,
    );

    for (const intervalMs of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        scheduler.register({ name: `bad-${intervalMs}`, intervalMs, run: vi.fn() }),
      ).toThrow(/whole number of milliseconds/);
    }
  });
});

/**
 * Once per interval across a fleet — on the test's clock, with the fleet's
 * locks in memory.
 */
describe('TaskScheduler across a fleet', () => {
  const MINUTE = 60_000;
  // Twenty-five seconds into a minute, so no replica starts on a boundary.
  const START = Date.UTC(2026, 8, 28, 12, 0, 25);
  const schedulers: TaskScheduler[] = [];

  const replica = (fleet: RedisLocks) => {
    const scheduler = new TaskScheduler(fleet, silent as never);
    schedulers.push(scheduler);
    return scheduler;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });

  afterEach(() => {
    for (const scheduler of schedulers.splice(0)) scheduler.stop();
    vi.useRealTimers();
  });

  it('runs an interval once, however many replicas reach it and whenever', async () => {
    const fleet = memoryLocks();
    const run = vi.fn().mockResolvedValue(undefined);

    replica(fleet).register({ name: 'sweep', intervalMs: MINUTE, run, runOnStart: true });
    await vi.advanceTimersByTimeAsync(10_000);
    // A second replica, started later in the same minute: its first run found the
    // lock released and ran the task again, before the interval was claimed.
    replica(fleet).register({ name: 'sweep', intervalMs: MINUTE, run, runOnStart: true });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(run).toHaveBeenCalledTimes(1);

    // Every following minute, once — not once per replica.
    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('ticks at the start of each interval, not an interval after it started', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    replica(memoryLocks()).register({ name: 'sweep', intervalMs: MINUTE, run });

    // Thirty-five seconds to 12:01, not sixty.
    await vi.advanceTimersByTimeAsync(34_999);
    expect(run).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not start an interval while the last one’s run is still going', async () => {
    const fleet = memoryLocks();
    let finish: () => void = () => undefined;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );

    replica(fleet).register({ name: 'sweep', intervalMs: MINUTE, run, runOnStart: true });
    replica(fleet).register({ name: 'sweep', intervalMs: MINUTE, run });
    await vi.advanceTimersByTimeAsync(2 * MINUTE);

    // Still the first run: the next two minutes' ticks found it going.
    expect(run).toHaveBeenCalledTimes(1);

    finish();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
