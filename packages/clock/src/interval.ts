/**
 * Milliseconds since the Unix epoch.
 *
 * A number rather than a `Date`, and that is the decision the rest of this
 * package rests on. `Date` carries a printed representation in whichever zone
 * the runtime happens to be in, and every bug this engine is written to avoid
 * begins with somebody reading that representation and believing it. A number
 * has no zone to misread.
 */
export type Instant = number;

/**
 * A half-open span of time, `[start, end)`.
 *
 * Half-open on purpose, and it matters more here than almost anywhere. An
 * appointment ending at 10:00 and one starting at 10:00 do not overlap; with
 * closed intervals they would, and every calendar in the product would refuse
 * back-to-back bookings — which is what a busy salon does all day.
 */
export interface Interval {
  readonly start: Instant;
  readonly end: Instant;
}

/** An interval with no duration holds no minute and can be discarded. */
export const isEmpty = (interval: Interval): boolean => interval.end <= interval.start;

export const durationMs = (interval: Interval): number =>
  Math.max(0, interval.end - interval.start);

export const durationMinutes = (interval: Interval): number => durationMs(interval) / 60_000;

/**
 * True when the two share at least one minute. Touching is not overlapping.
 *
 * An empty interval overlaps nothing, including an interval that surrounds it.
 * It holds no minutes, so there is nothing to share — and a zero-length step in
 * a structured service must not be able to block a slot.
 */
export const overlaps = (a: Interval, b: Interval): boolean =>
  !isEmpty(a) && !isEmpty(b) && a.start < b.end && b.start < a.end;

/** True when `outer` covers every minute of `inner`. */
export const contains = (outer: Interval, inner: Interval): boolean =>
  outer.start <= inner.start && inner.end <= outer.end;

/** The shared part, or undefined when they do not touch. */
export function intersect(a: Interval, b: Interval): Interval | undefined {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return end > start ? { start, end } : undefined;
}

/**
 * Sorts, drops the empty ones, and joins anything touching or overlapping.
 *
 * Every operation below assumes its inputs are in this shape, so it is applied
 * rather than trusted. Adjacent intervals are joined as well as overlapping
 * ones — 09:00–12:00 and 12:00–17:00 is one working day, not two, and leaving
 * them separate makes a service that spans noon unbookable for no reason a
 * person could discover.
 */
export function normalise(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals
    .filter((interval) => !isEmpty(interval))
    .sort((a, b) => a.start - b.start);

  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) {
      if (interval.end > last.end)
        merged[merged.length - 1] = { start: last.start, end: interval.end };
      continue;
    }
    merged.push({ start: interval.start, end: interval.end });
  }

  return merged;
}

/** Everything in `a` that is also in `b`, as a normalised list. */
export function intersectAll(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const left = normalise(a);
  const right = normalise(b);
  const result: Interval[] = [];

  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const shared = intersect(left[i]!, right[j]!);
    if (shared) result.push(shared);
    // Advance whichever ends first: the other may still meet the next one.
    if (left[i]!.end < right[j]!.end) i += 1;
    else j += 1;
  }

  return result;
}

/**
 * Everything in `from` that is not in `remove`.
 *
 * The operation the whole engine is built on: working hours minus bookings
 * minus breaks minus time off is what is left to offer.
 */
export function subtract(from: readonly Interval[], remove: readonly Interval[]): Interval[] {
  const busy = normalise(remove);
  const result: Interval[] = [];

  for (const interval of normalise(from)) {
    let cursor = interval.start;

    for (const taken of busy) {
      if (taken.end <= cursor) continue;
      if (taken.start >= interval.end) break;

      if (taken.start > cursor) result.push({ start: cursor, end: taken.start });
      cursor = Math.max(cursor, taken.end);
      if (cursor >= interval.end) break;
    }

    if (cursor < interval.end) result.push({ start: cursor, end: interval.end });
  }

  return result;
}

/** The parts of `intervals` that fall inside `bounds`. */
export const clamp = (intervals: readonly Interval[], bounds: Interval): Interval[] =>
  intersectAll(intervals, [bounds]);

/** Total time held, in minutes, counting overlaps once. */
export const totalMinutes = (intervals: readonly Interval[]): number =>
  normalise(intervals).reduce((total, interval) => total + durationMinutes(interval), 0);
