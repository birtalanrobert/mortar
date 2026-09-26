import { describe, expect, it } from 'vitest';
import { DEFAULT_BUCKETS_MS, InMemoryMetrics, createNoopMetrics } from './metrics';

describe('InMemoryMetrics', () => {
  it('counts', () => {
    const metrics = new InMemoryMetrics();
    const counter = metrics.counter('bookings_created');
    counter.increment();
    counter.increment(3);
    expect(metrics.value('bookings_created')).toBe(4);
  });

  it('separates series by label', () => {
    const metrics = new InMemoryMetrics();
    const counter = metrics.counter('messages_sent');
    counter.increment(1, { channel: 'sms' });
    counter.increment(2, { channel: 'email' });
    expect(metrics.value('messages_sent', { channel: 'sms' })).toBe(1);
    expect(metrics.value('messages_sent', { channel: 'email' })).toBe(2);
  });

  it('treats label order as insignificant', () => {
    const metrics = new InMemoryMetrics();
    metrics.counter('c').increment(1, { a: '1', b: '2' });
    expect(metrics.value('c', { b: '2', a: '1' })).toBe(1);
  });

  it('gauges up and down', () => {
    const metrics = new InMemoryMetrics();
    const gauge = metrics.gauge('queue_depth');
    gauge.set(10);
    gauge.increment(5);
    gauge.decrement(3);
    expect(metrics.value('queue_depth')).toBe(12);
  });

  it('records histogram observations', () => {
    const metrics = new InMemoryMetrics();
    const histogram = metrics.histogram('hold_latency_ms');
    histogram.observe(12);
    histogram.observe(30);
    expect(metrics.observations('hold_latency_ms')).toEqual([12, 30]);
  });

  it('times an operation and returns its result', async () => {
    const metrics = new InMemoryMetrics();
    const histogram = metrics.histogram('op_ms');
    const result = await histogram.time(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return 'done';
    });
    expect(result).toBe('done');
    expect(metrics.observations('op_ms')[0]).toBeGreaterThan(0);
  });

  it('records the duration even when the operation throws', async () => {
    const metrics = new InMemoryMetrics();
    const histogram = metrics.histogram('op_ms');
    await expect(
      histogram.time(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(metrics.observations('op_ms')).toHaveLength(1);
  });

  it('returns undefined for an unrecorded series', () => {
    expect(new InMemoryMetrics().value('never_touched')).toBeUndefined();
  });

  it('resets', () => {
    const metrics = new InMemoryMetrics();
    metrics.counter('c').increment();
    metrics.reset();
    expect(metrics.value('c')).toBeUndefined();
  });
});

describe('noop metrics', () => {
  it('accepts everything and records nothing', async () => {
    const metrics = createNoopMetrics();
    expect(() => metrics.counter('c').increment()).not.toThrow();
    expect(() => metrics.gauge('g').set(1)).not.toThrow();
    await expect(metrics.histogram('h').time(async () => 7)).resolves.toBe(7);
  });
});

describe('snapshot', () => {
  it('enumerates every series, which is what an exposition endpoint needs', () => {
    const metrics = new InMemoryMetrics();
    metrics.counter('jobs_total').increment(1, { queue: 'mail', status: 'completed' });
    metrics.counter('jobs_total').increment(2, { queue: 'mail', status: 'failed' });
    metrics.gauge('queue_depth').set(7, { queue: 'mail' });
    metrics.histogram('job_duration_ms').observe(10, { queue: 'mail' });
    metrics.histogram('job_duration_ms').observe(30, { queue: 'mail' });

    const snapshot = metrics.snapshot();

    expect(snapshot.counters).toHaveLength(2);
    expect(snapshot.counters).toContainEqual({
      name: 'jobs_total',
      labels: { queue: 'mail', status: 'failed' },
      value: 2,
    });
    expect(snapshot.gauges).toEqual([{ name: 'queue_depth', labels: { queue: 'mail' }, value: 7 }]);
    expect(snapshot.histograms).toEqual([
      {
        name: 'job_duration_ms',
        labels: { queue: 'mail' },
        count: 2,
        sum: 40,
        min: 10,
        max: 30,
        // DEFAULT_BUCKETS_MS, counted cumulatively: 10 is in every bucket from
        // 10 up, and 30 in every bucket from 50 up.
        buckets: DEFAULT_BUCKETS_MS.map((le) => ({ le, count: le < 10 ? 0 : le < 30 ? 1 : 2 })),
      },
    ]);
  });

  it('keeps labels whose values contain the key separators', () => {
    const metrics = new InMemoryMetrics();
    // Recovering labels by parsing the storage key would split this in two.
    metrics.histogram('probe').observe(1, { detail: 'a=b,c=d' });

    expect(metrics.snapshot().histograms[0]?.labels).toEqual({ detail: 'a=b,c=d' });
  });

  it('is empty before anything is recorded', () => {
    expect(new InMemoryMetrics().snapshot()).toEqual({
      counters: [],
      gauges: [],
      histograms: [],
    });
  });
});

/**
 * A histogram's memory, which is what a long-running process pays for it.
 *
 * It used to keep every observation: a process timing every request grew by one
 * number per request for as long as it ran, and `snapshot()` spread them all into
 * `Math.min`, which throws a `RangeError` past about a hundred thousand.
 */
describe('a histogram, however much it records', () => {
  it('stays the same size, and still snapshots', () => {
    const metrics = new InMemoryMetrics();
    const histogram = metrics.histogram('request_ms', 'How long.', [10, 100]);

    for (let index = 0; index < 1_000_000; index += 1) histogram.observe(index % 200);

    const [series] = metrics.snapshot().histograms;
    expect(series).toEqual({
      name: 'request_ms',
      labels: {},
      count: 1_000_000,
      sum: 99_500_000,
      min: 0,
      max: 199,
      buckets: [
        { le: 10, count: 55_000 },
        { le: 100, count: 505_000 },
      ],
    });
    expect(metrics.observations('request_ms')).toHaveLength(1000);
  });

  it('keeps its most recent observations for assertions, oldest first', () => {
    const metrics = new InMemoryMetrics({ recentObservations: 3 });
    const histogram = metrics.histogram('h');
    for (const value of [1, 2, 3, 4, 5]) histogram.observe(value);

    expect(metrics.observations('h')).toEqual([3, 4, 5]);
    // The counts cover everything, not only what is kept.
    expect(metrics.snapshot().histograms[0]).toEqual(
      expect.objectContaining({ count: 5, sum: 15, min: 1, max: 5 }),
    );
  });

  it('can keep none, and still counts', () => {
    const metrics = new InMemoryMetrics({ recentObservations: 0 });
    metrics.histogram('h').observe(7);

    expect(metrics.observations('h')).toEqual([]);
    expect(metrics.snapshot().histograms[0]?.count).toBe(1);
  });

  it('refuses to keep a count of observations that is not one', () => {
    expect(() => new InMemoryMetrics({ recentObservations: -1 })).toThrow('recentObservations');
    expect(() => new InMemoryMetrics({ recentObservations: 1.5 })).toThrow('recentObservations');
  });

  it('counts each bucket cumulatively, whatever order the bounds were given in', () => {
    const metrics = new InMemoryMetrics();
    const histogram = metrics.histogram('lag_seconds', 'Lag.', [5, 1]);
    for (const value of [0.5, 1, 3, 7, -2]) histogram.observe(value);

    expect(metrics.snapshot().histograms[0]).toEqual(
      expect.objectContaining({
        min: -2,
        max: 7,
        buckets: [
          { le: 1, count: 3 },
          { le: 5, count: 4 },
        ],
      }),
    );
  });

  it('is one histogram when named again without buckets, and refused when named with others', () => {
    const metrics = new InMemoryMetrics();
    metrics.histogram('lag_seconds', 'Lag.', [1, 5]).observe(2);
    metrics.histogram('lag_seconds').observe(3);

    expect(metrics.snapshot().histograms[0]?.count).toBe(2);
    expect(() => metrics.histogram('lag_seconds', 'Lag.', [1, 10])).toThrow(
      'already bucketed at [1, 5]',
    );
    expect(() => metrics.histogram('lag_seconds', 'Lag.', [5, 1])).not.toThrow();
  });
});
