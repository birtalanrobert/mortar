import type { Instant } from './interval';

/**
 * A calendar date in some location's own reckoning, `YYYY-MM-DD`.
 *
 * A string rather than a `Date`, because a date is not an instant. "Tuesday the
 * fourteenth" at a salon in Bucharest and the same date at one in Budapest are
 * different spans of real time, and anything that conflates them is wrong for
 * one of them.
 */
export type LocalDate = string;

/**
 * Minutes from local midnight. **May exceed 1440.**
 *
 * A tattoo studio open until 02:00 closes at minute 1560 of the day it opened,
 * not at minute 120 of the next one. Allowing the number to run past midnight
 * is what makes an overnight window a single interval rather than two rows that
 * something must remember to stitch together.
 */
export type MinuteOfDay = number;

export const MINUTES_PER_DAY = 1440;

/**
 * The offset from UTC, in minutes, that `zone` is on at `instant`.
 *
 * Read out of `Intl` rather than a table, so the tz database is the runtime's
 * and updates with it. `formatToParts` with a UTC-shaped format gives the local
 * wall clock; the difference from the instant is the offset.
 */
export function offsetMinutesAt(zone: string, instant: Instant): number {
  const parts = formatter(zone).formatToParts(new Date(instant));
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  const asUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    read('hour'),
    read('minute'),
    read('second'),
  );

  // Rounded to the minute: `Date.UTC` from the parts loses sub-second detail,
  // and no zone has ever had a sub-minute offset in the era this serves.
  return Math.round((asUtc - instant) / 60_000);
}

/**
 * How a wall-clock time that does not exist, or exists twice, was resolved.
 *
 * Returned rather than hidden, because both cases are worth reporting: an owner
 * whose Sunday shift is an hour shorter deserves to be told why, and the
 * explainer needs it to answer "why can't I book at half past two".
 */
export type ZoneResolution = 'exact' | 'gap' | 'ambiguous';

export interface ResolvedInstant {
  readonly instant: Instant;
  readonly resolution: ZoneResolution;
}

/**
 * Turns a local date plus minutes-from-midnight into an instant.
 *
 * The conversion the entire product depends on, and the one that is silently
 * wrong twice a year if it is done by adding a fixed offset. Both target
 * markets observe daylight saving, so this is exercised in anger every spring
 * and autumn.
 *
 * **How it works.** A wall clock plus a zone is not enough to name an instant,
 * so this asks the zone which offsets are in force around that moment — twelve
 * hours either side, which brackets any transition — and treats each as a
 * candidate. A candidate is real if converting it back to local time gives the
 * wall clock we started from. Exactly one does on an ordinary day.
 *
 * **`prefer` decides the two cases where the answer is not unique.**
 *
 * - A *gap*: on the spring morning the clock jumps 03:00 → 04:00, so 03:30 does
 *   not happen. No candidate round-trips, and the answer is the later one —
 *   which shifts the request forward by exactly the hour that vanished, so
 *   03:30 becomes 04:30. That is what `java.time` and every serious date
 *   library do, and it is the honest reading: a shift asked to run 03:30–11:00
 *   gets six and a half real hours, because an hour of it did not exist.
 *   Clamping to the transition instead would quietly hand back half an hour
 *   nobody worked.
 * - An *overlap*: on the autumn morning the clock repeats an hour, so 02:30 or
 *   03:30 — the zone decides which — happens twice. `'earliest'` takes the
 *   first, `'latest'` the second. **Window starts use `'earliest'` and ends use
 *   `'latest'`**, so a studio open 20:00–04:00 that night is open for the full
 *   extra hour rather than losing it to a rounding convention.
 */
export function toInstant(
  zone: string,
  date: LocalDate,
  minuteOfDay: MinuteOfDay,
  prefer: 'earliest' | 'latest' = 'earliest',
): ResolvedInstant {
  const wall = wallClockUtc(date, minuteOfDay);

  /*
   * Three probes, deduplicated.
   *
   * The offset twelve hours before, at, and twelve hours after the wall clock
   * read as UTC. Any transition near the moment in question falls inside that
   * window, so both sides of it are represented — which is what an earlier
   * version, iterating from a single guess, could not see: it converged on one
   * answer and reported an ambiguous hour as exact.
   */
  const probes = [wall - 43_200_000, wall, wall + 43_200_000];
  const offsets = [...new Set(probes.map((probe) => offsetMinutesAt(zone, probe)))];
  const candidates = [...new Set(offsets.map((offset) => wall - offset * 60_000))].sort(
    (a, b) => a - b,
  );

  // A candidate is real when it reads back as the wall clock asked for. In a
  // gap none do; in an overlap two do, an hour apart.
  const valid = candidates.filter((candidate) => localMinutesOf(zone, candidate) === wall);

  if (valid.length === 0) {
    return { instant: Math.max(...candidates), resolution: 'gap' };
  }

  if (valid.length === 1) {
    return { instant: valid[0]!, resolution: 'exact' };
  }

  return {
    instant: prefer === 'earliest' ? Math.min(...valid) : Math.max(...valid),
    resolution: 'ambiguous',
  };
}

/** The instant, without the resolution — for the many callers that do not care. */
export const instantAt = (
  zone: string,
  date: LocalDate,
  minuteOfDay: MinuteOfDay,
  prefer: 'earliest' | 'latest' = 'earliest',
): Instant => toInstant(zone, date, minuteOfDay, prefer).instant;

/** The local date an instant falls on, in `zone`. */
export function localDateOf(zone: string, instant: Instant): LocalDate {
  const parts = formatter(zone).formatToParts(new Date(instant));
  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  return `${read('year')}-${read('month')}-${read('day')}`;
}

/** Minutes from local midnight, for an instant, in `zone`. */
export function localMinuteOfDay(zone: string, instant: Instant): MinuteOfDay {
  const parts = formatter(zone).formatToParts(new Date(instant));
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  return read('hour') * 60 + read('minute');
}

/**
 * The day a zone gains or loses time, if it does so on this date.
 *
 * Used by the explainer and by the fixture suite. Returns the size of the shift
 * in minutes — positive when the clocks go forward — or zero for an ordinary
 * day.
 */
export function transitionMinutesOn(zone: string, date: LocalDate): number {
  const startOfDay = instantAt(zone, date, 0);
  const startOfNext = instantAt(zone, addDays(date, 1), 0);
  const realMinutes = (startOfNext - startOfDay) / 60_000;
  return MINUTES_PER_DAY - realMinutes;
}

/** `YYYY-MM-DD` plus a whole number of days, in the calendar rather than in time. */
export function addDays(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(parseDate(date) + days * 86_400_000);
  return shifted.toISOString().slice(0, 10);
}

/** 0 is Sunday, matching `Date.prototype.getUTCDay`. */
export const weekdayOf = (date: LocalDate): number => new Date(parseDate(date)).getUTCDay();

/** Whole days between two dates, in the calendar. Negative when `to` is earlier. */
export const daysBetween = (from: LocalDate, to: LocalDate): number =>
  Math.round((parseDate(to) - parseDate(from)) / 86_400_000);

/**
 * One formatter per zone, kept.
 *
 * Constructing an `Intl.DateTimeFormat` is expensive — tens of microseconds —
 * and this is called several times per candidate slot. A fortnight of
 * availability for one staff member makes thousands of calls, and without this
 * the engine spends most of its time building formatters it immediately
 * discards.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let cached = formatters.get(zone);
  if (!cached) {
    cached = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(zone, cached);
  }
  return cached;
}

/** The wall clock, encoded as though it were UTC. Never an instant on its own. */
const wallClockUtc = (date: LocalDate, minuteOfDay: MinuteOfDay): number =>
  parseDate(date) + minuteOfDay * 60_000;

/** The same encoding, read back out of a real instant. */
const localMinutesOf = (zone: string, instant: Instant): number => {
  const parts = formatter(zone).formatToParts(new Date(instant));
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  return Date.UTC(read('year'), read('month') - 1, read('day'), read('hour'), read('minute'));
};

function parseDate(date: LocalDate): number {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed)) throw new RangeError(`Not a date: ${date}`);
  return parsed;
}
