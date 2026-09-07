import { describe, expect, it } from 'vitest';

import {
  blocksTime,
  busyFrom,
  driftOf,
  healthOf,
  shouldPush,
  syncWindow,
  type CalendarEvent,
  type PushedCopy,
} from './sync';

const NOON = Date.UTC(2026, 5, 15, 12);
const hour = (h: number) => Date.UTC(2026, 5, 15, h);

function event(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    externalId: 'theirs-1',
    startsAt: hour(9),
    endsAt: hour(10),
    title: 'Dentist',
    busy: true,
    cancelled: false,
    ...over,
  };
}

const copy: PushedCopy = {
  externalId: 'ours-1',
  startsAt: hour(14),
  endsAt: hour(15),
  title: 'Ana Popescu — Cut',
};

describe('what happened to a copy we pushed', () => {
  it('is in step when nobody touched it', () => {
    expect(driftOf(copy, event({ ...copy, busy: true, cancelled: false }))).toEqual({
      kind: 'in-step',
    });
  });

  it('is edited when somebody moved it', () => {
    /*
     * The diary owns appointments. A stylist dragging an event in Google has
     * not told the customer anything, so the copy is what is wrong — and the
     * caller decides what to say about it.
     */
    const moved = event({ ...copy, startsAt: hour(16), endsAt: hour(17) });

    expect(driftOf(copy, moved)).toEqual({ kind: 'edited', theirs: moved });
  });

  it('is edited when somebody renamed it', () => {
    const renamed = event({ ...copy, title: 'Blocked' });

    expect(driftOf(copy, renamed)).toMatchObject({ kind: 'edited' });
  });

  it('is deleted when it is gone, or cancelled on their side', () => {
    expect(driftOf(copy, null)).toEqual({ kind: 'deleted' });
    expect(driftOf(copy, event({ ...copy, cancelled: true }))).toEqual({ kind: 'deleted' });
  });

  it('is missing when we have never written it out', () => {
    expect(driftOf(null, null)).toEqual({ kind: 'missing' });
  });
});

describe('their busy time', () => {
  const ours = new Set(['ours-1']);

  it('blocks a real appointment of theirs', () => {
    expect(blocksTime(event(), ours)).toBe(true);
  });

  it('never blocks on a copy we pushed ourselves', () => {
    // Reading back our own copy would block the slot the appointment already
    // occupies — and the next sync would block it again.
    expect(blocksTime(event({ externalId: 'ours-1' }), ours)).toBe(false);
  });

  it('ignores anything marked free', () => {
    // A "holiday season" banner across December is not a reason to stop taking
    // bookings, and calendars are full of them.
    expect(blocksTime(event({ busy: false }), ours)).toBe(false);
  });

  it('ignores cancelled events, which providers keep returning for a while', () => {
    expect(blocksTime(event({ cancelled: true }), ours)).toBe(false);
  });

  it('ignores an event with no length', () => {
    expect(blocksTime(event({ endsAt: hour(9) }), ours)).toBe(false);
  });

  it('merges overlapping meetings into one block', () => {
    /*
     * Four overlapping meetings are one stretch of unavailable time. A diary
     * showing four identical grey bars is a diary somebody stops reading.
     */
    const busy = busyFrom(
      [
        event({ externalId: 'a', startsAt: hour(9), endsAt: hour(10) }),
        event({ externalId: 'b', startsAt: hour(9), endsAt: hour(11) }),
        event({ externalId: 'c', startsAt: hour(10), endsAt: hour(12) }),
        event({ externalId: 'd', startsAt: hour(15), endsAt: hour(16) }),
      ],
      ours,
    );

    expect(busy).toEqual([
      { startsAt: hour(9), endsAt: hour(12) },
      { startsAt: hour(15), endsAt: hour(16) },
    ]);
  });

  it('keeps two blocks that merely touch apart from one that overlaps', () => {
    const busy = busyFrom(
      [
        event({ externalId: 'a', startsAt: hour(9), endsAt: hour(10) }),
        event({ externalId: 'b', startsAt: hour(10), endsAt: hour(11) }),
      ],
      ours,
    );

    // Touching at ten is one continuous stretch of busy, which is what somebody
    // with back-to-back meetings actually has.
    expect(busy).toEqual([{ startsAt: hour(9), endsAt: hour(11) }]);
  });
});

describe('what is worth pushing', () => {
  it('pushes an appointment inside the window', () => {
    expect(shouldPush({ startsAt: NOON + 86_400_000, cancelled: false }, NOON)).toBe(true);
  });

  it('does not push a cancelled one — its copy is deleted instead', () => {
    expect(shouldPush({ startsAt: NOON + 86_400_000, cancelled: true }, NOON)).toBe(false);
  });

  it('reaches back a fortnight, because an appointment can move into last week', () => {
    expect(shouldPush({ startsAt: NOON - 7 * 86_400_000, cancelled: false }, NOON)).toBe(true);
    expect(shouldPush({ startsAt: NOON - 30 * 86_400_000, cancelled: false }, NOON)).toBe(false);
  });

  it('stops three months out', () => {
    const window = syncWindow(NOON);

    expect(window.to - NOON).toBe(90 * 86_400_000);
    expect(shouldPush({ startsAt: NOON + 200 * 86_400_000, cancelled: false }, NOON)).toBe(false);
  });
});

describe('whether a connection is working', () => {
  it('forgives one failure, because providers have afternoons', () => {
    expect(healthOf(0, false)).toBe('working');
    expect(healthOf(1, false)).toBe('wobbling');
  });

  it('says it is broken once it has failed enough to matter', () => {
    /*
     * A stylist whose personal calendar has stopped blocking their diary needs
     * telling. One failure is noise; a day of them is a double booking waiting
     * to happen.
     */
    expect(healthOf(3, false)).toBe('broken');
  });

  it('says it is broken the moment access is revoked, whatever the count', () => {
    expect(healthOf(0, true)).toBe('broken');
  });
});
