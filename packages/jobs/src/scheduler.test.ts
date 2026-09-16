import { describe, expect, it, vi } from 'vitest';
import { TaskScheduler } from './scheduler';
import type { RedisLocks } from '@birtalanrobert/redis';

/** A lock that behaves however the test needs it to. */
const locks = (withLock: RedisLocks['withLock']): RedisLocks => ({ withLock }) as RedisLocks;

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
});
