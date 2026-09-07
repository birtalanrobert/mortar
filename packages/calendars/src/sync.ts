/**
 * The rules, which come first.
 *
 * A one-way feed cannot corrupt the diary it exports. A two-way sync can, and
 * that is the whole reason this file exists before any provider code: *what
 * wins when both sides change* has to be a stated rule rather than whichever
 * write happened to arrive last.
 *
 * ## The three rules
 *
 * 1. **The diary owns appointments.** An appointment belongs to the product
 *    that booked it. The external calendar holds a *copy*. If somebody edits or
 *    deletes that copy, the copy is wrong — not the appointment — and the next
 *    sync puts it back. A customer was told a time; a stylist dragging an event
 *    in Google has not told them anything.
 * 2. **The external calendar owns everything else.** A dentist appointment in
 *    somebody's personal calendar is busy time we must respect and must never
 *    touch. We read it, we block the slot, we do not edit it and we do not
 *    delete it.
 * 3. **Disconnecting changes nothing about the diary.** It removes our copies
 *    from their calendar and forgets their busy time. Every appointment stays
 *    exactly where it was.
 *
 * The asymmetry is the design. A "last write wins" sync between two systems
 * that both believe they are authoritative is how an appointment quietly moves
 * an hour and a customer arrives to an empty chair.
 */

export type Provider = 'google' | 'microsoft';

/** An event as either side describes it, reduced to what the rules need. */
export interface CalendarEvent {
  /** The provider's identifier for it. */
  readonly externalId: string;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly title: string;
  /** Whether the provider says this person is busy for it. */
  readonly busy: boolean;
  /** Whether it was cancelled or deleted on their side. */
  readonly cancelled: boolean;
}

/** What we last wrote out, so drift can be recognised. */
export interface PushedCopy {
  readonly externalId: string;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly title: string;
}

export type Drift =
  /** The copy is as we left it. */
  | { readonly kind: 'in-step' }
  /** Somebody moved or renamed our copy. Put it back. */
  | { readonly kind: 'edited'; readonly theirs: CalendarEvent }
  /** Somebody deleted our copy. Write it again. */
  | { readonly kind: 'deleted' }
  /** We have never written it out. */
  | { readonly kind: 'missing' };

/**
 * What happened to a copy we pushed.
 *
 * Named rather than acted on, because the *response* differs by product: this
 * one restores and tells the staff member, and an applicant-tracking system may
 * want to ask the recruiter first. The rule about who wins is shared; what to
 * say about it is not.
 */
export function driftOf(copy: PushedCopy | null, theirs: CalendarEvent | null): Drift {
  if (!copy) return { kind: 'missing' };
  if (!theirs || theirs.cancelled) return { kind: 'deleted' };

  const same =
    theirs.startsAt === copy.startsAt &&
    theirs.endsAt === copy.endsAt &&
    theirs.title === copy.title;

  return same ? { kind: 'in-step' } : { kind: 'edited', theirs };
}

/**
 * Whether one of their events is busy time we should block out.
 *
 * Three things are deliberately excluded and each has cost somebody a day:
 *
 * - **Our own copies.** Reading back what we pushed would block the slot the
 *   appointment already occupies, and the second sync would block it twice.
 * - **Anything marked free.** A "holiday season" banner across December is not
 *   a reason to stop taking bookings, and calendars are full of them.
 * - **Cancelled events**, which providers keep returning for a while after they
 *   are gone.
 */
export function blocksTime(event: CalendarEvent, ours: ReadonlySet<string>): boolean {
  if (ours.has(event.externalId)) return false;
  if (event.cancelled) return false;
  if (!event.busy) return false;

  return event.endsAt > event.startsAt;
}

/**
 * The busy periods to hold, from a window of their events.
 *
 * Merged, because a calendar with four overlapping meetings should produce one
 * block rather than four — a diary showing four identical grey bars is a diary
 * somebody stops reading.
 */
export function busyFrom(
  events: readonly CalendarEvent[],
  ours: ReadonlySet<string>,
): Array<{ startsAt: number; endsAt: number }> {
  const kept = events
    .filter((event) => blocksTime(event, ours))
    .map((event) => ({ startsAt: event.startsAt, endsAt: event.endsAt }))
    .sort((a, b) => a.startsAt - b.startsAt);

  const merged: Array<{ startsAt: number; endsAt: number }> = [];

  for (const period of kept) {
    const last = merged[merged.length - 1];

    if (last && period.startsAt <= last.endsAt) {
      last.endsAt = Math.max(last.endsAt, period.endsAt);
      continue;
    }

    merged.push({ ...period });
  }

  return merged;
}

/**
 * How far ahead and behind to sync.
 *
 * A fortnight back and three months forward. Backwards at all because an
 * appointment moved into last week still has a copy out there; three months
 * because that is roughly as far as anybody books, and pulling a decade of
 * somebody's personal calendar is a lot of data to hold about them for no
 * benefit — which is a data-protection argument as much as a performance one.
 */
export const SYNC_BEHIND_DAYS = 14;
export const SYNC_AHEAD_DAYS = 90;

export function syncWindow(now: number): { from: number; to: number } {
  return {
    from: now - SYNC_BEHIND_DAYS * 86_400_000,
    to: now + SYNC_AHEAD_DAYS * 86_400_000,
  };
}

/**
 * Whether an appointment is worth pushing at all.
 *
 * Cancelled ones are not — their copy is deleted instead — and neither is
 * anything outside the window, which would otherwise be written once and never
 * looked at again.
 */
export function shouldPush(
  appointment: { readonly startsAt: number; readonly cancelled: boolean },
  now: number,
): boolean {
  if (appointment.cancelled) return false;

  const window = syncWindow(now);

  return appointment.startsAt >= window.from && appointment.startsAt <= window.to;
}

/**
 * How long a connection may fail before somebody is told.
 *
 * A token expires, a person revokes access, a provider has an afternoon. One
 * failure is noise; a day of them is a stylist whose personal calendar is no
 * longer blocking their diary and who does not know it.
 */
export const FAILURES_BEFORE_TELLING = 3;

export type Health = 'working' | 'wobbling' | 'broken';

export function healthOf(consecutiveFailures: number, revoked: boolean): Health {
  if (revoked) return 'broken';
  if (consecutiveFailures >= FAILURES_BEFORE_TELLING) return 'broken';

  return consecutiveFailures === 0 ? 'working' : 'wobbling';
}
