import {
  createNoopLogger,
  createNoopMetrics,
  type Logger,
  type Metrics,
} from '@birtalanrobert/observability';
import type { RedisLocks } from '@birtalanrobert/redis';

export interface WindowScannerOptions<TItem> {
  /** Identifies this scanner in logs and in its lock. */
  name: string;
  /** How often to scan. */
  intervalMs: number;
  /**
   * How far ahead each scan looks.
   *
   * Must comfortably exceed `intervalMs`. The overlap is deliberate: a scan
   * that is late, or one that runs while the previous is still finishing, must
   * not leave a gap in which an item's moment passes unnoticed. Duplicates
   * from the overlap are handled by `keyFor`, so the safe direction is more
   * overlap rather than less.
   */
  windowMs: number;
  /** Items whose moment falls within `[from, to)`, read fresh each scan. */
  find: (from: Date, to: Date) => Promise<TItem[]>;
  /**
   * A stable key per item **and occurrence**.
   *
   * Deduplicates across overlapping windows. Must include whatever makes this
   * dispatch distinct — a reminder's key is the booking *and* which reminder
   * it is, or the 24-hour and 2-hour reminders would collapse into one.
   */
  keyFor: (item: TItem) => string;
  /** Acts on an item. Should be cheap; real work belongs on a queue. */
  dispatch: (item: TItem) => Promise<void>;
  /** How long a dispatch is remembered. Defaults to four windows. */
  dedupeTtlMs?: number;
  logger?: Logger;
  /**
   * Where scan counts, durations and the last-success timestamp go.
   *
   * The timestamp is the one worth alerting on. A scanner that has stopped
   * produces no errors and no logs — it simply stops finding work, and the
   * first anyone hears is a customer asking why they were never reminded.
   * Nothing else in this system fails that quietly.
   */
  metrics?: Metrics;
}

export interface ScanResult {
  readonly found: number;
  readonly dispatched: number;
  readonly skipped: number;
  readonly failed: number;
  readonly durationMs: number;
}

/**
 * Scans a forward window for work that is about to come due.
 *
 * **This pattern is needed constantly**, and every one of their
 * specifications warns against the obvious alternative: scheduling one job per
 * item at the moment it is created.
 *
 * That alternative fails because the world changes after the job is scheduled.
 * A booking is rescheduled and the old reminder still fires. A booking is
 * cancelled and the reminder fires anyway, telling someone about an
 * appointment that no longer exists. An order is collected early and the chaser
 * still goes out. Every one of those is a message a customer receives and a
 * business has to apologise for, and every fix means finding and cancelling a
 * job that may already be in flight.
 *
 * Scanning is self-correcting instead: each pass reads current state, so
 * anything cancelled simply is not found, and anything rescheduled is found at
 * its new time. Nothing needs to be un-scheduled, because nothing was
 * scheduled.
 */
export class WindowScanner<TItem> {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly logger: Logger;
  private readonly dedupeTtlMs: number;
  private readonly scanDuration;
  private readonly items;
  private readonly lastSuccess;

  constructor(
    private readonly options: WindowScannerOptions<TItem>,
    private readonly locks: RedisLocks,
  ) {
    this.logger = options.logger ?? createNoopLogger();
    this.dedupeTtlMs = options.dedupeTtlMs ?? options.windowMs * 4;

    const metrics = options.metrics ?? createNoopMetrics();
    this.scanDuration = metrics.histogram('scanner_scan_duration_ms', 'Time for one pass.');
    this.items = metrics.counter('scanner_items_total', 'Items seen, by outcome.');
    // A timestamp rather than an age: a gauge set only when a scan succeeds
    // cannot grow while the scanner is stalled, which is exactly when it
    // needs to. Monitoring subtracts it from now.
    this.lastSuccess = metrics.gauge(
      'scanner_last_success_timestamp_ms',
      'When a pass last completed. Alert on how old this is.',
    );

    if (options.windowMs <= options.intervalMs) {
      throw new Error(
        `Scanner '${options.name}': windowMs (${options.windowMs}) must exceed intervalMs ` +
          `(${options.intervalMs}), or a late scan leaves a gap where work is missed.`,
      );
    }
  }

  /**
   * Runs one pass.
   *
   * Held under a lock, so a scaled worker fleet scans once rather than once
   * per replica — and returns an empty result rather than an error when
   * another replica already holds it, because that is the expected outcome.
   */
  async scanOnce(now = new Date()): Promise<ScanResult> {
    const startedAt = Date.now();
    const empty: ScanResult = { found: 0, dispatched: 0, skipped: 0, failed: 0, durationMs: 0 };

    const result = await this.locks.withLock(
      `scanner:${this.options.name}`,
      async () => this.performScan(now),
      // Held only for the pass; long enough that a slow scan is not overtaken.
      { ttlMs: Math.max(this.options.intervalMs * 3, 30_000) },
    );

    if (!result) return { ...empty, durationMs: Date.now() - startedAt };
    return result;
  }

  private async performScan(now: Date): Promise<ScanResult> {
    const startedAt = Date.now();
    const to = new Date(now.getTime() + this.options.windowMs);

    let items: TItem[];
    try {
      items = await this.options.find(now, to);
    } catch (error) {
      this.logger.error('scanner query failed', error, { scanner: this.options.name });
      return { found: 0, dispatched: 0, skipped: 0, failed: 0, durationMs: Date.now() - startedAt };
    }

    let dispatched = 0;
    let skipped = 0;
    let failed = 0;

    for (const item of items) {
      const key = this.options.keyFor(item);

      // Claim before dispatching. Claiming after would let two overlapping
      // scans both dispatch before either recorded it.
      const claim = await this.locks.acquire(this.claimKey(key), { ttlMs: this.dedupeTtlMs });
      if (!claim) {
        skipped += 1;
        continue;
      }

      try {
        await this.options.dispatch(item);
        dispatched += 1;
      } catch (error) {
        failed += 1;
        // Release so the next pass retries: a dispatch that failed has not
        // happened, and leaving it claimed would drop the item silently. The
        // lock handle is kept precisely so this is possible.
        await claim.release();
        this.logger.warn('scanner dispatch failed', {
          scanner: this.options.name,
          key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const result: ScanResult = {
      found: items.length,
      dispatched,
      skipped,
      failed,
      durationMs: Date.now() - startedAt,
    };

    const labels = { scanner: this.options.name };
    this.scanDuration.observe(result.durationMs, labels);
    this.items.increment(dispatched, { ...labels, outcome: 'dispatched' });
    this.items.increment(skipped, { ...labels, outcome: 'skipped' });
    this.items.increment(failed, { ...labels, outcome: 'failed' });
    this.lastSuccess.set(Date.now(), labels);

    this.logger.debug('scan complete', { scanner: this.options.name, ...result });
    return result;
  }

  private claimKey(key: string): string {
    return `scanned:${this.options.name}:${key}`;
  }

  /** Begins scanning on the configured interval. */
  start(): void {
    if (this.timer) return;
    this.running = true;

    const tick = async (): Promise<void> => {
      if (!this.running) return;
      try {
        await this.scanOnce();
      } catch (error) {
        // A scanner that dies stops silently, and the first anyone hears is a
        // customer asking why they were never reminded.
        this.logger.error('scanner tick failed', error, { scanner: this.options.name });
      }
    };

    this.timer = setInterval(() => void tick(), this.options.intervalMs);
    // Never hold the process open on the scanner's account.
    this.timer.unref?.();
    void tick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
