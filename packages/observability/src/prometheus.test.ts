import { describe, expect, it } from 'vitest';
import { InMemoryMetrics, type MetricsSnapshot } from './metrics';
import { toPrometheus } from './prometheus';

const empty: MetricsSnapshot = { counters: [], gauges: [], histograms: [] };

describe('toPrometheus', () => {
  it('renders a counter with sorted labels', () => {
    const text = toPrometheus({
      ...empty,
      counters: [{ name: 'jobs_total', labels: { status: 'failed', queue: 'mail' }, value: 3 }],
    });

    // Sorted, so the same series renders identically between scrapes and a
    // diff of two scrapes shows what actually changed.
    expect(text).toBe('jobs_total{queue="mail",status="failed"} 3\n');
  });

  it('renders a series with no labels', () => {
    expect(toPrometheus({ ...empty, gauges: [{ name: 'up', labels: {}, value: 1 }] })).toBe(
      'up 1\n',
    );
  });

  it('expands a histogram into count, sum and max', () => {
    const text = toPrometheus({
      ...empty,
      histograms: [
        { name: 'job_duration_ms', labels: { job: 'send' }, count: 2, sum: 40, min: 10, max: 30 },
      ],
    });

    expect(text.split('\n').filter(Boolean)).toEqual([
      'job_duration_ms_count{job="send"} 2',
      'job_duration_ms_sum{job="send"} 40',
      'job_duration_ms_max{job="send"} 30',
    ]);
  });

  it('renders a histogram’s buckets, cumulative up to +Inf, before its count', () => {
    const text = toPrometheus({
      ...empty,
      histograms: [
        {
          name: 'lag_seconds',
          labels: { kind: 'noop' },
          count: 5,
          sum: 71.5,
          min: 0.5,
          max: 60,
          buckets: [
            { le: 1, count: 2 },
            { le: 5, count: 3 },
          ],
        },
      ],
    });

    expect(text.split('\n').filter(Boolean)).toEqual([
      'lag_seconds_bucket{kind="noop",le="1"} 2',
      'lag_seconds_bucket{kind="noop",le="5"} 3',
      'lag_seconds_bucket{kind="noop",le="+Inf"} 5',
      'lag_seconds_count{kind="noop"} 5',
      'lag_seconds_sum{kind="noop"} 71.5',
      'lag_seconds_max{kind="noop"} 60',
    ]);
  });

  it('renders what InMemoryMetrics records, buckets and all', () => {
    const metrics = new InMemoryMetrics();
    metrics.histogram('op_ms', 'An operation.', [10]).observe(4);

    expect(toPrometheus(metrics.snapshot())).toContain('op_ms_bucket{le="+Inf"} 1');
  });

  it('escapes backslashes before quotes', () => {
    // The order matters: escaping the quote first would then have its own
    // backslash escaped again, producing an unparseable line.
    const text = toPrometheus({
      ...empty,
      counters: [{ name: 'errors_total', labels: { detail: 'a\\b"c' }, value: 1 }],
    });

    expect(text).toBe('errors_total{detail="a\\\\b\\"c"} 1\n');
  });

  it('escapes newlines, which would otherwise split one sample into two', () => {
    const text = toPrometheus({
      ...empty,
      counters: [{ name: 'errors_total', labels: { detail: 'line\nbreak' }, value: 1 }],
    });

    expect(text.split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('ends with a newline, which Prometheus requires', () => {
    const text = toPrometheus({ ...empty, gauges: [{ name: 'up', labels: {}, value: 1 }] });
    expect(text.endsWith('\n')).toBe(true);
  });

  it('renders an empty snapshot as an empty body', () => {
    expect(toPrometheus(empty)).toBe('\n');
  });
});
