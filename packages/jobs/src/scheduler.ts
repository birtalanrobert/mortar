import { createNoopLogger, type Logger } from '@mortar/observability';
import type { RedisLocks } from '@mortar/redis';
import { runInChildContext } from '@mortar/context';

export interface ScheduledTask {
  /** Identifies the task in logs and in its lock. */
  name: string;
  intervalMs: number;
  run: () => Promise<void>;
  /**
   * How long the lock is held.
   *
   * Must exceed the task's realistic worst-case duration, or a second replica
   * takes the lock while the first is still working and the task runs twice.
   * Defaults to three intervals.
   */
  lockTtlMs?: number;
  /** Run immediately on start as well as on the interval. Default false. */
  runOnStart?: boolean;
}

/**
 * Runs recurring tasks exactly once across a scaled fleet.
 *
 * Every replica schedules every task; the lock decides which one actually
 * runs. That is deliberately simpler than electing a leader — there is no
 * election to get wrong, no split brain, and a replica dying mid-task means
 * the lock expires and the next interval picks it up.
 */
export class TaskScheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly logger: Logger;

  constructor(
    private readonly locks: RedisLocks,
    logger?: Logger,
  ) {
    this.logger = logger ?? createNoopLogger();
  }

  register(task: ScheduledTask): this {
    if (this.timers.has(task.name)) {
      throw new Error(`A scheduled task named '${task.name}' is already registered.`);
    }

    const tick = async (): Promise<void> => {
      const ran = await this.locks.withLock(`task:${task.name}`, async () => this.execute(task), {
        ttlMs: task.lockTtlMs ?? task.intervalMs * 3,
      });
      if (ran === undefined) {
        this.logger.debug('scheduled task skipped; another replica holds it', {
          task: task.name,
        });
      }
    };

    const timer = setInterval(() => void tick(), task.intervalMs);
    timer.unref?.();
    this.timers.set(task.name, timer);

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
      if (timer) clearInterval(timer);
      this.timers.delete(name);
      return;
    }
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
  }
}
