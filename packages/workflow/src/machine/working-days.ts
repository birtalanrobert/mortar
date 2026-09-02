/**
 * Due dates counted in working days, in the subject's own time zone.
 *
 * "Three days" from a counter on a Friday afternoon means Wednesday, not
 * Monday, and everybody involved knows that except the software. Counting in
 * calendar days produces a promise the shop cannot keep and a chasing list that
 * fires over a weekend nobody worked.
 *
 * The time zone is not decoration. A deadline computed in UTC for a shop in
 * Bucharest is wrong by a day for anything set after 21:00 local in summer, and
 * the failure is invisible until somebody is chased a day early.
 */

export interface WorkingCalendar {
  /**
   * Days that are not worked, as `Date.getDay()` numbers — 0 is Sunday.
   *
   * Configurable rather than assumed: a repair shop that opens on Saturday and
   * closes on Monday is ordinary, and a package that hard-codes Saturday and
   * Sunday is one they cannot use.
   */
  readonly weekend: readonly number[];
  /**
   * Public holidays, as `YYYY-MM-DD` in the calendar's own zone.
   *
   * Strings rather than `Date`s on purpose. A holiday is a *date*, not an
   * instant, and storing it as one is how a holiday list quietly shifts by a
   * day when the server's zone differs from the shop's.
   */
  readonly holidays: readonly string[];
  /** An IANA name, e.g. `Europe/Bucharest`. */
  readonly timeZone: string;
}

export const DEFAULT_CALENDAR: WorkingCalendar = {
  weekend: [0, 6],
  holidays: [],
  timeZone: 'UTC',
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** The calendar date and weekday an instant falls on, where the calendar is. */
function localDay(instant: Date, timeZone: string): { date: string; weekday: number } {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';

  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    weekday: WEEKDAYS[get('weekday')] ?? 0,
  };
}

export function isWorkingDay(instant: Date, calendar: WorkingCalendar): boolean {
  const { date, weekday } = localDay(instant, calendar.timeZone);
  if (calendar.weekend.includes(weekday)) return false;
  return !calendar.holidays.includes(date);
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * `count` working days after (or, negative, before) an instant.
 *
 * The time of day is preserved, which is what makes "three working days" from a
 * 16:00 booking land at 16:00 — a deadline snapped to midnight is either half a
 * day early or half a day late, and both get argued about at the counter.
 *
 * Counting starts the day *after* the instant. A device booked in on Monday
 * with a two-working-day promise is due Wednesday: Monday is the day it
 * arrived, not a day of work on it.
 */
export function addWorkingDays(
  from: Date,
  count: number,
  calendar: WorkingCalendar = DEFAULT_CALENDAR,
): Date {
  if (!Number.isInteger(count)) {
    throw new RangeError(`Working days must be a whole number, not ${count}`);
  }

  if (count === 0) return new Date(from.getTime());

  const step = count > 0 ? DAY : -DAY;
  let remaining = Math.abs(count);
  let cursor = new Date(from.getTime());

  /*
   * A guard, not an optimisation. A calendar whose weekend covers all seven
   * days — reachable by a form with seven checkboxes — would otherwise spin
   * forever inside a request. Ten years is far past any real deadline.
   */
  const limit = Math.abs(count) * 7 + 3660;
  for (let steps = 0; remaining > 0; steps += 1) {
    if (steps > limit) {
      throw new RangeError(
        'This calendar has no working days: every weekday is a weekend or a holiday',
      );
    }
    cursor = new Date(cursor.getTime() + step);
    if (isWorkingDay(cursor, calendar)) remaining -= 1;
  }

  return cursor;
}

/**
 * Working days between two instants, counting the later one and not the earlier.
 *
 * Negative when `to` is before `from`, so the sign says which way round they
 * were — a caller that wants a magnitude can say so, and one that silently got
 * a positive number from a reversed pair cannot.
 */
export function workingDaysBetween(
  from: Date,
  to: Date,
  calendar: WorkingCalendar = DEFAULT_CALENDAR,
): number {
  if (from.getTime() === to.getTime()) return 0;

  const forwards = from.getTime() < to.getTime();
  const [earlier, later] = forwards ? [from, to] : [to, from];

  let days = 0;
  let cursor = new Date(earlier.getTime());

  while (cursor.getTime() < later.getTime()) {
    cursor = new Date(cursor.getTime() + DAY);
    if (cursor.getTime() <= later.getTime() && isWorkingDay(cursor, calendar)) days += 1;
  }

  return forwards ? days : -days;
}

/**
 * The instant a subject must have entered its state before, to have been held
 * there for `workingDays` working days.
 *
 * A cutoff rather than a predicate, because this is the shape a query needs:
 * `WHERE state = $1 AND state_changed_at < $2`. A predicate would mean loading
 * every row to filter it in memory, which is the version of this that works
 * until the first shop with a real backlog.
 */
export function heldSinceCutoff(
  now: Date,
  workingDays: number,
  calendar: WorkingCalendar = DEFAULT_CALENDAR,
): Date {
  if (workingDays < 0) throw new RangeError('A holding threshold cannot be negative');
  return addWorkingDays(now, -workingDays, calendar);
}
