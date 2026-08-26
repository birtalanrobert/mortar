import { createHash } from 'node:crypto';
import { getContext } from '@birtalanrobert/context';
import { resolveManager, runInTransaction } from '@birtalanrobert/database';
import { ConflictError, ValidationError } from '@birtalanrobert/http';
import { IsNull, type DataSource, type EntityManager } from 'typeorm';
import { IdempotencyRecord } from './entity';

export interface IdempotencyOptions {
  /** How long a completed response is replayable. Default 24 hours. */
  ttlMs?: number;
  /**
   * How long a claim may stay `in_progress` before it is treated as abandoned.
   *
   * A process that dies mid-request leaves a claim behind. Without a lock
   * timeout that key is poisoned forever and the client can never retry.
   * Default 5 minutes — comfortably longer than any request should take.
   */
  lockTimeoutMs?: number;
}

export type BeginResult =
  /** No prior claim: the caller should do the work. */
  | { outcome: 'proceed'; record: IdempotencyRecord }
  /** Completed before: replay the stored response, do nothing else. */
  | { outcome: 'replay'; status: number; body: unknown };

/**
 * Serializes a response for replay, dropping anything JSON cannot carry.
 *
 * Returns null only when there is genuinely nothing to store, so SQL NULL and
 * "the handler returned null" stay distinguishable.
 */
function serializeResponse(body: unknown): string | null {
  if (body === undefined) return 'null';
  try {
    return JSON.stringify(body) ?? 'null';
  } catch {
    return 'null';
  }
}

/** Computes the payload fingerprint. Stable across key ordering. */
export function fingerprint(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/**
 * Idempotency for mutating endpoints.
 *
 * The commit boundaries are the whole design, and they are not symmetrical:
 *
 * - **The claim commits immediately, in its own transaction.** A concurrent
 *   duplicate must be able to *see* the claim, which it cannot do if the claim
 *   is sitting uncommitted inside the first request's transaction.
 * - **The completion commits with the work.** If `complete()` were a separate
 *   transaction, a crash between the two would leave the work done and the key
 *   unfinished — and the retry would do the work twice, which is the exact
 *   failure this package exists to prevent.
 *
 * This is needed wherever clients double-submit: an
 * order submitted twice becomes real food, a duplicated attack command is
 * unrecoverable, and a doubled payment is a refund and an apology.
 */
export class IdempotencyService {
  private readonly ttlMs: number;
  private readonly lockTimeoutMs: number;

  constructor(
    private readonly dataSource: DataSource,
    options: IdempotencyOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5 * 60 * 1000;
  }

  /**
   * Claims a key, or reports that this request has already been answered.
   *
   * Throws `ConflictError` when an identical request is still running, and
   * `ValidationError` when the key was reused for a different payload.
   */
  async begin(key: string, scope: string, payload: unknown): Promise<BeginResult> {
    const tenantId = getContext()?.tenantId ?? null;
    const print = fingerprint(payload);
    const now = new Date();

    // Independent: the claim must be visible to a concurrent duplicate the
    // moment it exists, so it cannot wait for the caller's transaction.
    return runInTransaction(
      this.dataSource,
      async (manager) => {
        const existing = await manager.findOne(IdempotencyRecord, {
          where: { tenantId: tenantId ?? IsNull(), scope, key },
          lock: { mode: 'pessimistic_write' },
        });

        if (existing) {
          const decision = this.evaluate(existing, print, now);
          if (decision) return decision;
          // Expired, or an abandoned claim: take it over.
          await manager.remove(IdempotencyRecord, existing);
        }

        const record = manager.create(IdempotencyRecord, {
          tenantId,
          scope,
          key,
          fingerprint: print,
          status: 'in_progress',
          responseStatus: null,
          responseBody: null,
          claimedAt: now,
          completedAt: null,
          expiresAt: new Date(now.getTime() + this.ttlMs),
        });

        return { outcome: 'proceed', record: await manager.save(IdempotencyRecord, record) };
      },
      { independent: true },
    );
  }

  private evaluate(existing: IdempotencyRecord, print: string, now: Date): BeginResult | null {
    if (existing.expiresAt <= now) return null;

    if (existing.fingerprint !== print) {
      // Silently replaying the first response here would hide a client bug and
      // give them an answer to a question they did not ask.
      throw new ValidationError(
        [
          {
            field: 'Idempotency-Key',
            message: 'This idempotency key was already used with a different request payload.',
            code: 'idempotency_key_reused',
          },
        ],
        'Idempotency key reused with a different payload.',
      );
    }

    if (existing.status === 'completed') {
      return {
        outcome: 'replay',
        status: existing.responseStatus ?? 200,
        body:
          existing.responseBody === null ? null : (JSON.parse(existing.responseBody) as unknown),
      };
    }

    const abandoned = now.getTime() - existing.claimedAt.getTime() > this.lockTimeoutMs;
    if (abandoned) return null;

    throw new ConflictError(
      'A request with this idempotency key is already in progress. Retry shortly.',
      { meta: { code: 'idempotency_in_progress' } },
    );
  }

  /**
   * Marks the claim completed and stores the response.
   *
   * Deliberately joins the caller's transaction: work and completion commit
   * together, or neither does.
   */
  async complete(
    record: IdempotencyRecord,
    responseStatus: number,
    responseBody: unknown,
    manager?: EntityManager,
  ): Promise<void> {
    const em = manager ?? resolveManager(this.dataSource);
    await em.update(
      IdempotencyRecord,
      { id: record.id },
      {
        status: 'completed',
        responseStatus,
        responseBody: serializeResponse(responseBody),
        completedAt: new Date(),
      },
    );
  }

  /**
   * Releases a claim so the client may retry.
   *
   * Called when the work failed. Runs independently, because the caller's
   * transaction is being rolled back and anything written inside it would go
   * with it — leaving a claim that blocks retries until the lock timeout.
   */
  async release(record: IdempotencyRecord): Promise<void> {
    await runInTransaction(
      this.dataSource,
      async (manager) => {
        await manager.delete(IdempotencyRecord, { id: record.id, status: 'in_progress' });
      },
      { independent: true },
    );
  }

  /** Deletes expired keys. Safe to run on a schedule. */
  async purgeExpired(now = new Date()): Promise<number> {
    const result = await this.dataSource
      .createQueryBuilder()
      .delete()
      .from(IdempotencyRecord)
      .where('expires_at < :now', { now })
      .execute();
    return result.affected ?? 0;
  }
}
