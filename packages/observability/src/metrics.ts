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

export interface MetricSeries {
  readonly name: string;
  readonly labels: MetricLabels;
  readonly value: number;
}

/** How many observations fell at or below `le` — cumulative, as Prometheus reads a bucket. */
export interface HistogramBucket {
  readonly le: number;
  readonly count: number;
}

export interface HistogramSeries {
  readonly name: string;
  readonly labels: MetricLabels;
  readonly count: number;
  readonly sum: number;
  readonly min: number;
  readonly max: number;
  /**
   * One entry per bound, cumulative. Optional so that a snapshot assembled by
   * hand — in a test, or by an adapter that has no buckets — is still one;
   * `InMemoryMetrics` always fills it.
   */
  readonly buckets?: readonly HistogramBucket[];
}

export interface MetricsSnapshot {
  readonly counters: readonly MetricSeries[];
  readonly gauges: readonly MetricSeries[];
  readonly histograms: readonly HistogramSeries[];
}

export interface InMemoryMetricsOptions {
  /**
   * How many of a series' most recent observations `observations()` can
   * return. Everything else a histogram knows is a fixed number of counters,
   * so this is the only thing about it that grows with use — and it stops
   * growing here.
   */
  readonly recentObservations?: number;
}

/** How many recent observations each histogram series keeps for `observations()`, unless told otherwise. */
export const DEFAULT_RECENT_OBSERVATIONS = 1000;

/**
 * One histogram series: a count per bucket, the count, sum, minimum and
 * maximum — all fixed in size whatever is observed — and a ring of the most
 * recent observations.
 */
class HistogramState {
  readonly counts: number[];
  count = 0;
  sum = 0;
  min = Infinity;
  max = -Infinity;
  private readonly recent: number[] = [];
  private next = 0;

  constructor(
    readonly labels: MetricLabels,
    private readonly bounds: readonly number[],
    private readonly keep: number,
  ) {
    this.counts = bounds.map(() => 0);
  }

  observe(value: number): void {
    const index = this.bounds.findIndex((bound) => value <= bound);
    if (index >= 0) this.counts[index]! += 1;
    this.count += 1;
    this.sum += value;
    if (value < this.min) this.min = value;
    if (value > this.max) this.max = value;

    if (this.keep === 0) return;
    if (this.recent.length < this.keep) {
      this.recent.push(value);
    } else {
      this.recent[this.next] = value;
      this.next = (this.next + 1) % this.keep;
    }
  }

  /** The kept observations, oldest first. */
  observations(): readonly number[] {
    return this.recent.length < this.keep
      ? [...this.recent]
      : [...this.recent.slice(this.next), ...this.recent.slice(0, this.next)];
  }

  buckets(): HistogramBucket[] {
    let running = 0;
    return this.bounds.map((le, index) => ({ le, count: (running += this.counts[index]!) }));
  }
}

interface HistogramFamily {
  readonly bounds: readonly number[];
  readonly series: Map<string, HistogramState>;
}

/**
 * An in-memory registry: what a process serves on `/metrics`, and what a test
 * asserts on when an assertion on a metric is the clearest way to prove a code
 * path ran.
 *
 * **Its memory does not grow with what it records.** A histogram is a count per
 * bucket, a count, a sum, a minimum and a maximum — the shape Prometheus keeps —
 * plus a bounded ring of the most recent observations for `observations()`. It
 * used to keep every observation, for exact percentiles: a process timing every
 * request then grew by one number per request for as long as it ran, and its
 * snapshot spread them all into `Math.min`, which throws past about a hundred
 * thousand. That is the default registry `LoggerModule` gives a production
 * process, so it has to hold for one.
 */
export class InMemoryMetrics implements Metrics {
  private readonly counters = new Map<string, Map<string, Sample>>();
  private readonly gauges = new Map<string, Map<string, Sample>>();
  private readonly histograms = new Map<string, HistogramFamily>();
  private readonly keep: number;

  constructor(options: InMemoryMetricsOptions = {}) {
    const keep = options.recentObservations ?? DEFAULT_RECENT_OBSERVATIONS;
    if (!Number.isInteger(keep) || keep < 0) {
      throw new Error(`recentObservations must be a whole number of at least 0, not ${keep}.`);
    }
    this.keep = keep;
  }

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

  /**
   * A histogram, bucketed at `buckets` — `DEFAULT_BUCKETS_MS` unless given.
   *
   * The first caller to name a histogram fixes its buckets. Naming it again
   * without buckets is the same histogram; naming it again with different
   * ones is refused, because one metric counted into two sets of buckets is
   * two metrics under one name, and a quantile read across them is nonsense.
   */
  histogram(name: string, _help?: string, buckets?: readonly number[]): Histogram {
    let family = this.histograms.get(name);
    if (!family) {
      const bounds = [...(buckets ?? DEFAULT_BUCKETS_MS)].sort((a, b) => a - b);
      if (bounds.some((bound) => !Number.isFinite(bound))) {
        throw new Error(`Histogram ${name}: every bucket bound must be a finite number.`);
      }
      family = { bounds, series: new Map() };
      this.histograms.set(name, family);
    } else if (buckets && [...buckets].sort((a, b) => a - b).join() !== family.bounds.join()) {
      throw new Error(`Histogram ${name} is already bucketed at [${family.bounds.join(', ')}].`);
    }

    const { bounds, series } = family;
    const observe = (value: number, labels: MetricLabels = {}) => {
      const key = labelKey(labels);
      let state = series.get(key);
      // The labels are stored beside the counts rather than recovered from the
      // key later: a label value containing `=` or `,` would not survive the
      // round trip, and one eventually will.
      if (!state) {
        state = new HistogramState(labels, bounds, this.keep);
        series.set(key, state);
      }
      state.observe(value);
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
   * Histograms carry their buckets, cumulative, beside the count, sum, minimum
   * and maximum — so a percentile can be read from what is scraped
   * (`histogram_quantile` over `_bucket`).
   */
  snapshot(): MetricsSnapshot {
    const flatten = (source: Map<string, Map<string, Sample>>): MetricSeries[] =>
      [...source.entries()].flatMap(([name, series]) =>
        [...series.values()].map(({ labels, value }) => ({ name, labels, value })),
      );

    return {
      counters: flatten(this.counters),
      gauges: flatten(this.gauges),
      histograms: [...this.histograms.entries()].flatMap(([name, family]) =>
        [...family.series.values()].map((state) => ({
          name,
          labels: state.labels,
          count: state.count,
          sum: state.sum,
          min: state.count > 0 ? state.min : 0,
          max: state.count > 0 ? state.max : 0,
          buckets: state.buckets(),
        })),
      ),
    };
  }

  /** Current value of a counter or gauge, for assertions. */
  value(name: string, labels: MetricLabels = {}): number | undefined {
    const key = labelKey(labels);
    return this.counters.get(name)?.get(key)?.value ?? this.gauges.get(name)?.get(key)?.value;
  }

  /**
   * A histogram's most recent observations, oldest first, for assertions: at
   * most `recentObservations` of them (a thousand by default). The counts in
   * `snapshot()` cover everything ever observed.
   */
  observations(name: string, labels: MetricLabels = {}): readonly number[] {
    return this.histograms.get(name)?.series.get(labelKey(labels))?.observations() ?? [];
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
