/**
 * Two-way calendar sync: our appointments pushed out, their busy time pulled in.
 *
 * **Framework-free and browser-safe.** A console shows whether a calendar is
 * connected and when it last synced, so nothing here reaches for a database, a
 * clock or a provider SDK. The entities and the adapters live behind
 * `/nestjs`, `/google` and `/microsoft`.
 *
 * The rules in `sync.ts` are the point of the package. A one-way feed cannot
 * corrupt the diary it exports; a two-way sync can, and *what wins when both
 * sides change* has to be a stated rule rather than whichever write arrived
 * last.
 */

export {
  FAILURES_BEFORE_TELLING,
  SYNC_AHEAD_DAYS,
  SYNC_BEHIND_DAYS,
  blocksTime,
  busyFrom,
  driftOf,
  healthOf,
  shouldPush,
  syncWindow,
  type CalendarEvent,
  type Drift,
  type Health,
  type Provider,
  type PushedCopy,
} from './sync';
