import type { PrinterTransport } from './transport';

/** One thing to print, and everything needed to try again. */
export interface PrintJob {
  readonly id: string;
  /** Which printer. The product's own name for it. */
  readonly printer: string;
  readonly bytes: Buffer;
  /** For a log or an alert: "table 7's grill ticket", not an id. */
  readonly describedAs?: string;
}

export type JobOutcome =
  | { readonly state: 'printed'; readonly attempts: number }
  | { readonly state: 'failed'; readonly attempts: number; readonly reason: string };

export interface QueueOptions {
  /** Resolves the printer a job names. Unknown printers are a failure, not a crash. */
  readonly transportFor: (printer: string) => PrinterTransport | undefined;
  /**
   * How many times a job is tried before somebody is told.
   *
   * Three, and the reason is the failure it is protecting against: a printer
   * that is briefly busy or whose socket was refused mid-shift. A printer that
   * is out of paper fails identically every time, and a fourth attempt only
   * delays the moment a person finds out.
   */
  readonly attempts?: number;
  readonly backoffMs?: (attempt: number) => number;
  /**
   * Told when a job has run out of attempts.
   *
   * **Not optional in practice.** A print queue that swallows a failure is a
   * kitchen that never receives a ticket and never learns it did not — which is
   * §5.1's cardinal failure with a different device in the middle.
   */
  readonly onFailure?: (job: PrintJob, reason: string) => void | Promise<void>;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Printing, with the delivery guarantee this product family needs.
 *
 * The package owns the *bytes* and the *retrying*; a product owns the layout
 * and what to do when paper runs out. What makes this worth sharing is that
 * getting the second part wrong is invisible: a job that failed silently is a
 * kitchen with no ticket, and the first anybody knows is a guest asking where
 * their food is.
 *
 * Deliberately not BullMQ. A print job is worthless a minute after it was
 * created — a ticket that arrives after the table has left is noise — so it
 * belongs in memory beside the process that made it, retried for seconds and
 * then escalated to a person. Durability across a restart would be the wrong
 * promise: on a restart, what a kitchen needs is the *current* tickets, which
 * the display and the database already have.
 */
export class PrintQueue {
  private running = false;
  private readonly waiting: PrintJob[] = [];

  constructor(private readonly options: QueueOptions) {}

  get depth(): number {
    return this.waiting.length;
  }

  /** Queues a job and returns when it has printed or run out of attempts. */
  async print(job: PrintJob): Promise<JobOutcome> {
    const transport = this.options.transportFor(job.printer);

    if (!transport) {
      const reason = `No printer called “${job.printer}” is configured.`;
      await this.options.onFailure?.(job, reason);

      // A configuration mistake rather than a device that is unwell: retrying
      // it three times would delay the only useful answer by six seconds.
      return { state: 'failed', attempts: 0, reason };
    }

    const attempts = this.options.attempts ?? 3;
    const backoff = this.options.backoffMs ?? ((attempt) => 250 * 2 ** (attempt - 1));
    const sleep = this.options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));

    let reason = '';

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await transport.send(job.bytes);
        return { state: 'printed', attempts: attempt };
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
        if (attempt < attempts) await sleep(backoff(attempt));
      }
    }

    /*
     * Somebody is told. The queue does not decide what that means — a station
     * screen, a manager's phone, a row on the floor staff app — but it does
     * insist that the failure leaves this object rather than being counted.
     */
    await this.options.onFailure?.(job, reason);

    return { state: 'failed', attempts, reason };
  }

  /**
   * Queues a job to be printed after the ones already waiting.
   *
   * Serial per queue, because a thermal printer is a single-threaded device:
   * two jobs sent at once interleave into one ticket with half of each on it,
   * which is worse than either arriving late.
   */
  enqueue(job: PrintJob, onDone?: (outcome: JobOutcome) => void): void {
    this.waiting.push(job);
    void this.drain(onDone);
  }

  private async drain(onDone?: (outcome: JobOutcome) => void): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      while (this.waiting.length > 0) {
        const job = this.waiting.shift()!;
        const outcome = await this.print(job);
        onDone?.(outcome);
      }
    } finally {
      this.running = false;
    }
  }
}
