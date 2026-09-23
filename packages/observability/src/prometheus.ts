import type { MetricsSnapshot } from './metrics';

/**
 * Renders a metrics snapshot as Prometheus text exposition.
 *
 * **The format a scraper reads**, which is the reason this is here rather than
 * in whichever process first needed it: a deployment points one scraper at an
 * API and a worker, and two processes rendering the same registry differently
 * is a dashboard that can only ever show half of a system.
 *
 * Histograms are exposed as `_count`, `_sum` and `_max` rather than as buckets.
 * A Prometheus histogram needs bucket boundaries chosen in advance and a
 * `_bucket` series per boundary; the figure actually read off these — mean
 * duration — is `rate(_sum) / rate(_count)`, which needs neither. `_max` is not
 * a Prometheus convention and is carried anyway, because the slowest request in
 * a window is the question somebody asks during an incident and an average
 * cannot answer it.
 *
 * Deliberately not a registry of its own: it takes a snapshot and returns a
 * string, so a process can serve it from Nest, from `node:http`, or write it to
 * a file, without this having an opinion about which.
 */
export function toPrometheus(snapshot: MetricsSnapshot): string {
  const lines: string[] = [];

  for (const series of snapshot.counters) {
    lines.push(format(series.name, series.labels, series.value));
  }
  for (const series of snapshot.gauges) {
    lines.push(format(series.name, series.labels, series.value));
  }
  for (const series of snapshot.histograms) {
    lines.push(format(`${series.name}_count`, series.labels, series.count));
    lines.push(format(`${series.name}_sum`, series.labels, series.sum));
    lines.push(format(`${series.name}_max`, series.labels, series.max));
  }

  // Prometheus requires the body to end with a newline; without it the last
  // sample is silently dropped.
  return `${lines.join('\n')}\n`;
}

function format(name: string, labels: Record<string, string | number>, value: number): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return `${name} ${value}`;

  const rendered = entries
    .map(([key, raw]) => `${key}="${escapeLabel(String(raw))}"`)
    .sort()
    .join(',');

  return `${name}{${rendered}} ${value}`;
}

/**
 * Backslash, double quote and newline, in that order.
 *
 * Order matters: escaping the quote first would then have its own backslash
 * escaped by the next pass, producing `\\"` and an unparseable line.
 */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
