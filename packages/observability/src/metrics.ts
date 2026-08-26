/**
 * A deliberately small metrics abstraction.
 *
 * Mortar does not choose an exporter. Every service names the
 * metrics it needs — hold-acquisition latency, reminder dispatch lag, kiosk
 * sync failures, event-resolution lag — but they will be shipped to whatever
 * the deployment target offers. So this package defines the *surface* those
 * metrics are recorded against and ships an in-memory implementation for tests
 * and local work; wiring it to Prometheus, OTLP or a hosted collector is one
 * small adapter written per deployment, not a dependency imposed on every
 * projects.
 */

export type MetricLabels = Record<string, string | number>;

export interface Counter {
  /** Adds to the count. Defaults to 1. */
  increment(value?: number, labels?: MetricLabels): void;
}

export interface Gauge {
  set(value: number, labels?: MetricLabels): void;
  increment(value?: number, labels?: MetricLabels): void;
  decrement(value?: number, labels?: MetricLabels): void;
}

export interface Histogram {
  observe(value: number, labels?: MetricLabels): void;
  /** Times an operation and observes its duration in milliseconds. */
  time<T>(operation: () => Promise<T>, labels?: MetricLabels): Promise<T>;
}

export interface Metrics {
  counter(name: string, help?: string): Counter;
  gauge(name: string, help?: string): Gauge;
  histogram(name: string, help?: string, buckets?: readonly number[]): Histogram;
}

/** Default histogram buckets, in milliseconds, spanning fast to pathological. */
export const DEFAULT_BUCKETS_MS: readonly number[] = [
  1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000,
];

interface Sample {
  readonly labels: MetricLabels;
  value: number;
}

function labelKey(labels: MetricLabels = {}): string {
  const keys = Object.keys(labels).sort();
  return keys.map((key) => `${key}=${String(labels[key])}`).join(',');
}

/**
 * An in-memory implementation, useful in tests where an assertion on a metric
 * is the clearest way to prove a code path ran.
 */
interface Observations {
  readonly labels: MetricLabels;
  readonly values: number[];
}

export interface MetricSeries {
  readonly name: string;
  readonly labels: MetricLabels;
  readonly value: number;
}

export interface HistogramSeries {
  readonly name: string;
  readonly labels: MetricLabels;
  readonly count: number;
  readonly sum: number;
  readonly min: number;
  readonly max: number;
}

export interface MetricsSnapshot {
  readonly counters: readonly MetricSeries[];
  readonly gauges: readonly MetricSeries[];
  readonly histograms: readonly HistogramSeries[];
}

export class InMemoryMetrics implements Metrics {
  private readonly counters = new Map<string, Map<string, Sample>>();
  private readonly gauges = new Map<string, Map<string, Sample>>();
  private readonly histograms = new Map<string, Map<string, Observations>>();

  counter(name: string): Counter {
    const series = this.series(this.counters, name);
    return {
      increment: (value = 1, labels = {}) => {
        const key = labelKey(labels);
        const existing = series.get(key);
        if (existing) existing.value += value;
        else series.set(key, { labels, value });
      },
    };
  }

  gauge(name: string): Gauge {
    const series = this.series(this.gauges, name);
    const adjust = (delta: number, labels: MetricLabels) => {
      const key = labelKey(labels);
      const existing = series.get(key);
      if (existing) existing.value += delta;
      else series.set(key, { labels, value: delta });
    };
    return {
      set: (value, labels = {}) => series.set(labelKey(labels), { labels, value }),
      increment: (value = 1, labels = {}) => adjust(value, labels),
      decrement: (value = 1, labels = {}) => adjust(-value, labels),
    };
  }

  histogram(name: string): Histogram {
    let series = this.histograms.get(name);
    if (!series) {
      series = new Map<string, Observations>();
      this.histograms.set(name, series);
    }
    const observations = series;
    const observe = (value: number, labels: MetricLabels = {}) => {
      const key = labelKey(labels);
      const bucket = observations.get(key);
      // The labels are stored beside the values rather than recovered from the
      // key later: a label value containing `=` or `,` would not survive the
      // round trip, and one eventually will.
      if (bucket) bucket.values.push(value);
      else observations.set(key, { labels, values: [value] });
    };
    return {
      observe,
      time: async <T>(operation: () => Promise<T>, labels: MetricLabels = {}) => {
        const startedAt = process.hrtime.bigint();
        try {
          return await operation();
        } finally {
          observe(Number(process.hrtime.bigint() - startedAt) / 1_000_000, labels);
        }
      },
    };
  }

  /**
   * Every series currently held, for an exposition endpoint.
   *
   * A `/metrics` route needs to enumerate what exists; `value()` and
   * `observations()` can only answer about a name the caller already knows,
   * which an exporter by definition does not.
   *
   * Histograms are reported as count, sum, min and max rather than as buckets.
   * Bucketing is a presentation decision that belongs to whatever scrapes this,
   * and keeping raw observations here means a percentile can still be computed
   * exactly rather than interpolated.
   */
  snapshot(): MetricsSnapshot {
    const flatten = (source: Map<string, Map<string, Sample>>): MetricSeries[] =>
      [...source.entries()].flatMap(([name, series]) =>
        [...series.values()].map(({ labels, value }) => ({ name, labels, value })),
      );

    return {
      counters: flatten(this.counters),
      gauges: flatten(this.gauges),
      histograms: [...this.histograms.entries()].flatMap(([name, series]) =>
        [...series.values()].map(({ labels, values }) => ({
          name,
          labels,
          count: values.length,
          sum: values.reduce((total, value) => total + value, 0),
          min: values.length > 0 ? Math.min(...values) : 0,
          max: values.length > 0 ? Math.max(...values) : 0,
        })),
      ),
    };
  }

  /** Current value of a counter or gauge, for assertions. */
  value(name: string, labels: MetricLabels = {}): number | undefined {
    const key = labelKey(labels);
    return this.counters.get(name)?.get(key)?.value ?? this.gauges.get(name)?.get(key)?.value;
  }

  /** Recorded observations of a histogram, for assertions. */
  observations(name: string, labels: MetricLabels = {}): readonly number[] {
    return this.histograms.get(name)?.get(labelKey(labels))?.values ?? [];
  }

  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }

  private series(store: Map<string, Map<string, Sample>>, name: string): Map<string, Sample> {
    let series = store.get(name);
    if (!series) {
      series = new Map<string, Sample>();
      store.set(name, series);
    }
    return series;
  }
}

/** A metrics implementation that records nothing. */
export function createNoopMetrics(): Metrics {
  const counter: Counter = { increment: () => undefined };
  const gauge: Gauge = {
    set: () => undefined,
    increment: () => undefined,
    decrement: () => undefined,
  };
  const histogram: Histogram = {
    observe: () => undefined,
    time: async (operation) => operation(),
  };
  return {
    counter: () => counter,
    gauge: () => gauge,
    histogram: () => histogram,
  };
}
