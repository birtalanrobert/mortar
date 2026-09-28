import { createNoopLogger, type Logger } from '@birtalanrobert/observability';
import type { RedisLocks } from '@birtalanrobert/redis';
import { runInChildContext } from '@birtalanrobert/context';

export interface ScheduledTask {
  /** Identifies the task in logs and in its lock. */
  name: string;
  intervalMs: number;
  run: () => Promise<void>;
  /**
   * How long the lock held while a run is going lasts.
   *
   * Must exceed the task's realistic worst-case duration, or a second replica
   * takes the lock while the first is still working and the task runs twice.
   * Defaults to three intervals.
   */
  lockTtlMs?: number;
  /**
   * Also run at once, if this interval has not run yet anywhere in the fleet.
   * Default false: the first run is then at the next interval's start.
   */
  runOnStart?: boolean;
}

export interface TaskSchedulerOptions {
  /** The clock intervals are counted on, in milliseconds. The system's unless a test says. */
  readonly now?: () => number;
}

/**
 * Runs recurring tasks once per interval across a scaled fleet.
 *
 * Every replica schedules every task; two locks decide which one runs, and
 * when. That is deliberately simpler than electing a leader — there is no
 * election to get wrong, no split brain, and a replica dying mid-task means
 * the lock expires and the next interval picks it up.
 *
 * **Intervals are counted from the epoch, not from when a replica started.**
 * Every replica ticks at the start of each interval — 12:00, 12:15, 12:30 for
 * fifteen minutes — and the first to tick claims that interval. The claim is
 * never released, only left to expire after the interval has passed, so a
 * replica whose tick comes later in the same interval finds it taken.
 *
 * Before this, each replica ticked an interval after it had started and the
 * lock was released when a run finished. Replicas start at different moments,
 * so their ticks fell at different points in each interval, and each one found
 * the lock free: three replicas ran a fifteen-minute task three times every
 * fifteen minutes, and a nightly task three times a night. The lock only ever
 * stopped two runs happening at the same moment, which is the other thing it
 * still does: a run still going when the next interval starts is not joined by
 * a second.
 */
export class TaskScheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(
    private readonly locks: RedisLocks,
    logger?: Logger,
    options: TaskSchedulerOptions = {},
  ) {
    this.logger = logger ?? createNoopLogger();
    this.now = options.now ?? (() => Date.now());
  }

  register(task: ScheduledTask): this {
    if (this.timers.has(task.name)) {
      throw new Error(`A scheduled task named '${task.name}' is already registered.`);
    }
    if (!Number.isInteger(task.intervalMs) || task.intervalMs < 1) {
      throw new Error(
        `The scheduled task '${task.name}' has an interval of ${task.intervalMs}; it must be a whole number of milliseconds.`,
      );
    }

    const tick = async (): Promise<void> => {
      /*
       * The **lock** is guarded as well as the task.
       *
       * `execute` swallows what `task.run` throws, for the reason below it —
       * but taking the lock happens out here, and a rejection from that escapes
       * an interval callback and takes the process down. Redis restarting, a
       * connection closing during shutdown, a network blip: all of them are
       * reasons to skip one tick and try again on the next interval, and none
       * of them is a reason to stop a worker that has other jobs to run.
       *
       * Found when a seed script — an application context that boots the
       * modules and immediately closes — exited non-zero about one run in
       * three, because a task with `runOnStart` was reaching for a lock while
       * the connection was being torn down. A deploy step that fails
       * intermittently is one somebody makes non-blocking, which is worse.
       */
      const interval = Math.floor(this.now() / task.intervalMs);

      try {
        const outcome = await this.locks.withLock(
          `task:${task.name}`,
          async () => {
            // The interval, claimed for good: it expires after the interval has
            // passed and is never released, so nobody else runs it again.
            const claim = await this.locks.acquire(`task:${task.name}:interval:${interval}`, {
              ttlMs: task.intervalMs * 2,
            });
            if (!claim) return 'already-run' as const;
            await this.execute(task);
            return 'ran' as const;
          },
          { ttlMs: task.lockTtlMs ?? task.intervalMs * 3 },
        );

        if (outcome === undefined) {
          this.logger.debug('scheduled task skipped; a run is still going', { task: task.name });
        } else if (outcome === 'already-run') {
          this.logger.debug('scheduled task skipped; this interval has run', { task: task.name });
        }
      } catch (error) {
        this.logger.error('scheduled task could not take its lock', error, { task: task.name });
      }
    };

    /*
     * The next tick is set for the next interval's start, worked out afresh
     * each time rather than repeated with `setInterval`, so a timer that fires
     * late never carries its lateness forward — and one that fires a moment
     * early finds its interval already run and is set again for the one it
     * meant.
     */
    const arm = (): void => {
      const now = this.now();
      const next = (Math.floor(now / task.intervalMs) + 1) * task.intervalMs;
      const timer = setTimeout(() => {
        arm();
        void tick();
      }, next - now);
      timer.unref?.();
      this.timers.set(task.name, timer);
    };

    arm();
    if (task.runOnStart) void tick();
    return this;
  }

  private async execute(task: ScheduledTask): Promise<void> {
    const startedAt = Date.now();
    // A child context so the task's logs carry a correlation id of their own,
    // rather than appearing as orphaned lines.
    await runInChildContext(
      { source: 'job', actor: { id: task.name, type: 'system' } },
      async () => {
        try {
          await task.run();
          this.logger.info('scheduled task completed', {
            task: task.name,
            durationMs: Date.now() - startedAt,
          });
        } catch (error) {
          // Swallowed after logging: a throw here would escape an interval
          // callback and take the process down, which is a poor response to one
          // failed nightly report.
          this.logger.error('scheduled task failed', error, {
            task: task.name,
            durationMs: Date.now() - startedAt,
          });
        }
      },
    );
  }

  stop(name?: string): void {
    if (name) {
      const timer = this.timers.get(name);
      if (timer) clearTimeout(timer);
      this.timers.delete(name);
      return;
    }
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
