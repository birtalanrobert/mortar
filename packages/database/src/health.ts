import type { DataSource } from 'typeorm';

export interface DatabaseHealth {
  readonly status: 'up' | 'down';
  readonly latencyMs?: number;
  readonly error?: string;
  readonly pool?: {
    readonly total: number;
    readonly idle: number;
    readonly waiting: number;
  };
}

/**
 * Checks the database is reachable and reports pool pressure.
 *
 * The pool figures matter more than the boolean: a service whose pool is
 * exhausted is failing even though every individual query still succeeds, and
 * `waiting > 0` sustained is the signal that precedes an outage.
 */
export async function checkDatabaseHealth(
  dataSource: DataSource,
  timeoutMs = 3000,
): Promise<DatabaseHealth> {
  if (!dataSource.isInitialized) {
    return { status: 'down', error: 'DataSource is not initialized' };
  }

  const startedAt = process.hrtime.bigint();

  try {
    await withTimeout(dataSource.query('SELECT 1'), timeoutMs);
    return {
      status: 'up',
      latencyMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 1000) / 1000,
      pool: readPoolStats(dataSource),
    };
  } catch (error) {
    return {
      status: 'down',
      error: error instanceof Error ? error.message : String(error),
      pool: readPoolStats(dataSource),
    };
  }
}

function readPoolStats(dataSource: DataSource): DatabaseHealth['pool'] {
  // node-postgres exposes these on the pool; the shape is not in TypeORM's
  // public types, so it is read defensively rather than asserted.
  const pool = (dataSource.driver as { master?: unknown }).master as
    { totalCount?: number; idleCount?: number; waitingCount?: number } | undefined;
  if (!pool || typeof pool.totalCount !== 'number') return undefined;
  return {
    total: pool.totalCount,
    idle: pool.idleCount ?? 0,
    waiting: pool.waitingCount ?? 0,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Database health check timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
