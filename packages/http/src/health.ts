export type HealthStatus = 'up' | 'down' | 'degraded';

export interface IndicatorResult {
  readonly status: HealthStatus;
  readonly latencyMs?: number;
  readonly error?: string;
  readonly details?: Record<string, unknown>;
}

export interface HealthIndicator {
  /** Appears as the key in the report, e.g. `database`. */
  readonly name: string;
  /**
   * Whether a failure here means the service cannot serve traffic.
   *
   * A failing database is critical; a failing metrics exporter is not, and
   * taking a service out of the load balancer because its metrics sink is
   * unreachable turns a cosmetic problem into an outage.
   */
  readonly critical?: boolean;
  check(): Promise<IndicatorResult>;
}

export interface HealthReport {
  readonly status: HealthStatus;
  readonly checks: Record<string, IndicatorResult>;
  readonly durationMs: number;
}

/**
 * Runs health indicators and aggregates their results.
 *
 * Indicators are registered rather than hard-coded because what a service
 * depends on varies: an API needs the database and Redis, a worker needs the
 * queue, a scanner-facing service needs object storage.
 */
export class HealthRegistry {
  private readonly indicators = new Map<string, HealthIndicator>();

  register(indicator: HealthIndicator): this {
    this.indicators.set(indicator.name, indicator);
    return this;
  }

  unregister(name: string): this {
    this.indicators.delete(name);
    return this;
  }

  list(): readonly HealthIndicator[] {
    return [...this.indicators.values()];
  }

  /**
   * Checks every indicator in parallel, bounded by `timeoutMs`.
   *
   * The timeout is per-indicator and enforced here rather than trusted to the
   * indicator, because the failure mode this endpoint most needs to survive is
   * a dependency that hangs rather than one that errors.
   */
  async check(timeoutMs = 5000): Promise<HealthReport> {
    const startedAt = process.hrtime.bigint();
    const indicators = this.list();

    const results = await Promise.all(
      indicators.map(async (indicator) => {
        try {
          const result = await withTimeout(indicator.check(), timeoutMs, indicator.name);
          return [indicator, result] as const;
        } catch (error) {
          return [
            indicator,
            {
              status: 'down' as const,
              error: error instanceof Error ? error.message : String(error),
            },
          ] as const;
        }
      }),
    );

    const checks: Record<string, IndicatorResult> = {};
    let anyCriticalDown = false;
    let anyDown = false;

    for (const [indicator, result] of results) {
      checks[indicator.name] = result;
      if (result.status === 'down') {
        anyDown = true;
        if (indicator.critical !== false) anyCriticalDown = true;
      } else if (result.status === 'degraded') {
        anyDown = anyDown || false;
      }
    }

    const degraded = Object.values(checks).some((c) => c.status === 'degraded');

    return {
      status: anyCriticalDown ? 'down' : anyDown || degraded ? 'degraded' : 'up',
      checks,
      durationMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 1000) / 1000,
    };
  }
}

/** Builds an indicator from a plain async function. */
export function createIndicator(
  name: string,
  check: () => Promise<IndicatorResult>,
  critical = true,
): HealthIndicator {
  return { name, critical, check };
}

function withTimeout<T>(promise: Promise<T>, ms: number, name: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Health check '${name}' timed out after ${ms}ms`)),
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
