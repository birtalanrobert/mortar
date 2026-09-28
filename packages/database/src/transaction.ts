import { AsyncLocalStorage } from 'node:async_hooks';
import type { DataSource, EntityManager, QueryRunner } from 'typeorm';

/**
 * The active transaction, carried through AsyncLocalStorage.
 *
 * This is the mechanism that makes mortar composable with application code.
 * Without it, a package holding its own connection cannot join the caller's
 * transaction — which means an audit row could be written for a change that
 * then rolls back, an idempotency key could be committed for work that never
 * happened, and an RLS session variable set on one connection would not apply
 * to queries issued on another. All three are silent correctness failures.
 */
interface TransactionScope {
  readonly manager: EntityManager;
  readonly queryRunner: QueryRunner;
  /** Nesting depth; > 0 means we are inside a savepoint, not a top-level tx. */
  readonly depth: number;
  /**
   * Callbacks registered at this level, to run once the outermost transaction
   * has committed.
   *
   * **One list per level, not one shared.** A savepoint hands its list to its
   * parent when it is released and drops it when it rolls back, so a callback
   * registered for work that was rolled back to a savepoint never runs — even
   * though the transaction around it goes on to commit. A shared list ran it:
   * the email for an account whose creation was undone, sent anyway.
   */
  readonly afterCommit: Array<() => void | Promise<void>>;
  /**
   * Whether this module commits the transaction, and so knows when to run the
   * callbacks. False for one bound from outside with `bindTransactionManager`,
   * which the code that opened it commits.
   */
  readonly commitsHere: boolean;
}

const storage = new AsyncLocalStorage<TransactionScope>();

/** The active transaction's EntityManager, or undefined outside a transaction. */
export function getTransactionManager(): EntityManager | undefined {
  return storage.getStore()?.manager;
}

/** Whether a transaction is currently active. */
export function isInTransaction(): boolean {
  return storage.getStore() !== undefined;
}

/** Current nesting depth; 0 outside a transaction. */
export function transactionDepth(): number {
  const scope = storage.getStore();
  return scope ? scope.depth + 1 : 0;
}

/**
 * Returns the EntityManager work should use: the active transaction's if there
 * is one, otherwise the DataSource's own.
 *
 * Every mortar repository resolves its manager through this, which is what
 * makes "join the caller's transaction if there is one" the default rather
 * than something each package has to remember.
 */
export function resolveManager(dataSource: DataSource): EntityManager {
  return storage.getStore()?.manager ?? dataSource.manager;
}

export interface TransactionOptions {
  /**
   * Postgres isolation level. Left to the database default unless a caller
   * has a specific reason — most work does not.
   */
  isolationLevel?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';
  /**
   * Force a new independent transaction even if one is already active.
   *
   * Use sparingly and deliberately: work that must survive the outer
   * transaction rolling back, such as recording that an external call was
   * attempted.
   */
  independent?: boolean;
  /**
   * Run before the transaction body, on the transaction's own connection.
   * This is how `@birtalanrobert/tenancy` sets `SET LOCAL app.tenant_id` so that
   * row-level security applies to every statement inside.
   */
  onBegin?: (queryRunner: QueryRunner) => Promise<void>;
}

/**
 * Runs `work` inside a transaction.
 *
 * Nesting is handled with savepoints rather than by opening a second
 * transaction, so an inner failure rolls back only the inner work and the
 * outer transaction can decide what to do about it.
 */
export async function runInTransaction<T>(
  dataSource: DataSource,
  work: (manager: EntityManager) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const existing = storage.getStore();

  if (existing && !options.independent) {
    return runInSavepoint(existing, work);
  }

  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  await queryRunner.startTransaction(options.isolationLevel);

  const scope: TransactionScope = {
    manager: queryRunner.manager,
    queryRunner,
    depth: 0,
    afterCommit: [],
    commitsHere: true,
  };

  try {
    if (options.onBegin) await options.onBegin(queryRunner);

    const result = await storage.run(scope, () => work(queryRunner.manager));
    await queryRunner.commitTransaction();

    // After commit, never before: a callback that sends an email or enqueues a
    // job must not fire for work that then rolled back. Failures here are
    // reported by the caller's own error handling, not by rolling back a
    // transaction that has already committed.
    for (const callback of scope.afterCommit) {
      await callback();
    }

    return result;
  } catch (error) {
    if (queryRunner.isTransactionActive) {
      await queryRunner.rollbackTransaction();
    }
    throw error;
  } finally {
    await queryRunner.release();
  }
}

async function runInSavepoint<T>(
  parent: TransactionScope,
  work: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  const { queryRunner } = parent;
  const name = `mortar_sp_${parent.depth + 1}_${Date.now().toString(36)}`;

  await queryRunner.query(`SAVEPOINT "${name}"`);

  const scope: TransactionScope = {
    manager: parent.manager,
    queryRunner,
    depth: parent.depth + 1,
    afterCommit: [],
    commitsHere: parent.commitsHere,
  };

  try {
    const result = await storage.run(scope, () => work(parent.manager));
    await queryRunner.query(`RELEASE SAVEPOINT "${name}"`);
    // Its work is now the parent's, and so are its callbacks: they run once,
    // after the transaction that actually commits, in the order registered.
    parent.afterCommit.push(...scope.afterCommit);
    return result;
  } catch (error) {
    // Its work is undone, and what was to follow that work goes with it.
    await queryRunner.query(`ROLLBACK TO SAVEPOINT "${name}"`);
    throw error;
  }
}

/**
 * Registers a callback to run after the outermost transaction commits.
 *
 * The correct place for side effects that must not happen if the work rolls
 * back: sending a confirmation, enqueuing a job, invalidating a cache. If no
 * transaction is active the callback runs immediately, so callers do not need
 * to branch.
 *
 * Registered inside a savepoint, it runs only if that savepoint is released as
 * well as the transaction committed: work rolled back to a savepoint takes its
 * callbacks with it.
 *
 * **Refused inside `bindTransactionManager`.** That transaction is committed
 * by the code that opened it, which this module never sees, so the callback
 * would never run — and a side effect silently dropped is the failure this
 * function exists to prevent. Register it where that transaction is committed.
 */
export async function afterCommit(callback: () => void | Promise<void>): Promise<void> {
  const scope = storage.getStore();
  if (!scope) {
    await callback();
    return;
  }
  if (!scope.commitsHere) {
    throw new Error(
      'afterCommit() cannot run inside a transaction bound with bindTransactionManager(): ' +
        'that transaction is committed by the code that opened it, so the callback would ' +
        'never run. Register the side effect where that transaction is committed.',
    );
  }
  scope.afterCommit.push(callback);
}

/**
 * Runs `work` with a specific EntityManager bound as the ambient transaction.
 *
 * The bridge for code that already has a manager — a TypeORM subscriber, or an
 * application using `dataSource.transaction()` directly — so mortar writes
 * inside it still join that transaction.
 *
 * `afterCommit` is refused inside it: the transaction is committed by the code
 * that opened it, out of this module's sight, so a callback registered here
 * could never be run.
 */
export async function bindTransactionManager<T>(
  manager: EntityManager,
  work: () => Promise<T>,
): Promise<T> {
  // `async` so that a bad argument rejects rather than throwing synchronously.
  // A function typed `Promise<T>` that sometimes throws before returning forces
  // every caller to write both a try/catch and a .catch(), which nobody does.
  const queryRunner = manager.queryRunner;
  if (!queryRunner) {
    throw new Error(
      'bindTransactionManager() requires a transactional EntityManager (one with a queryRunner).',
    );
  }
  return storage.run({ manager, queryRunner, depth: 0, afterCommit: [], commitsHere: false }, work);
}
