import type { CommitParticipant } from '@birtalanrobert/database';
import type { IdempotencyRecord } from './entity';
import type { IdempotencyService } from './service';

/**
 * A claimed key while its handler runs.
 *
 * The handler's work commits in transactions the interceptor never sees —
 * opened deep inside a service, each committed where it was opened. So the
 * claim joins every one of them (`participant`): the first transaction to
 * commit a write marks the key done as its last statement, and the key and
 * that work commit together or not at all. A crash between the work and the
 * response can no longer leave the work done and the key free to do it again.
 *
 * If the handler fails before any such transaction has committed, nothing was
 * done, and the key is released for the caller's retry. If one has, the key
 * stays spent: a retry is answered, not repeated — even when the handler
 * failed afterwards, for instance in a callback run after its commit.
 */
export class ClaimInFlight {
  private settled = false;
  private done = false;

  constructor(
    private readonly service: IdempotencyService,
    private readonly record: IdempotencyRecord,
    private readonly status: number,
  ) {}

  /** Joins each transaction committed while the handler runs (`joinCommits`). */
  readonly participant: CommitParticipant = async (manager) => {
    if (this.settled || this.done) return;
    // A transaction that wrote nothing did none of the work: Postgres gives a
    // transaction an id only once it writes — or locks a row to write it.
    const [row] = (await manager.query('SELECT pg_current_xact_id_if_assigned() AS id')) as Array<{
      id: string | null;
    }>;
    if (!row?.id) return;
    await this.service.markDone(this.record, this.status, manager);
    return () => {
      this.done = true;
    };
  };

  /**
   * The handler answered: its response is stored for any repeat. When the key
   * already stands for the work, failing to store the response does not fail
   * the request — a repeat then replays the status alone.
   */
  async succeeded(body: unknown): Promise<void> {
    this.settled = true;
    try {
      await this.service.complete(this.record, this.status, body);
    } catch (error) {
      if (!this.done) throw error;
    }
  }

  /**
   * The handler failed. With nothing committed the key is released, so the
   * caller may try again under it; a claim that cannot be released is left to
   * expire as an abandoned one does, and the handler's own error is the one
   * the caller hears.
   */
  async failed(): Promise<void> {
    this.settled = true;
    if (this.done) return;
    await this.service.release(this.record).catch(() => undefined);
  }
}
