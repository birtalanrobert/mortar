/**
 * Wall-clock and interval arithmetic, across time zones, without a dependency.
 *
 * **A date is not an instant, and a duration is not a difference of wall
 * clocks.** Almost every scheduling bug in this catalogue is one of those two
 * sentences being forgotten: "Tuesday the fourteenth" is a different span of
 * real time in Bucharest and in Budapest, and a 22:00–06:00 shift is seven
 * hours on the spring-forward night and nine on the autumn one.
 *
 * Extracted from project 02's slot engine at its second consumer — project 07's
 * rota — and shared because six of the seventeen specifications schedule
 * against somebody's local wall clock. What stays in each project is the engine
 * built *on* this: the slot engine, the rules engine, the costing engine. They
 * share this substrate and no logic.
 *
 * Zero dependencies and framework-free, deliberately: it is imported by browser
 * bundles that redraw a grid on every drag as well as by workers deciding what
 * is due, and the tz database it reads is the runtime's own through `Intl`, so
 * it updates with the platform rather than with a release of this.
 */
export {
  clamp,
  contains,
  durationMinutes,
  durationMs,
  intersect,
  intersectAll,
  isEmpty,
  normalise,
  overlaps,
  subtract,
  totalMinutes,
  type Instant,
  type Interval,
} from './interval';

export {
  MINUTES_PER_DAY,
  addDays,
  daysBetween,
  instantAt,
  localDateOf,
  localMinuteOfDay,
  offsetMinutesAt,
  toInstant,
  transitionMinutesOn,
  weekdayOf,
  type LocalDate,
  type MinuteOfDay,
  type ResolvedInstant,
  type ZoneResolution,
} from './zone';
