import { describe, expect, it } from 'vitest';
import type { MetricsSnapshot } from './metrics';
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
