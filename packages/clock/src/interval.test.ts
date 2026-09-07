import { describe, expect, it } from 'vitest';
import {
  clamp,
  contains,
  intersect,
  intersectAll,
  normalise,
  overlaps,
  subtract,
  totalMinutes,
  type Interval,
} from './interval';

/** Readable fixtures: minutes from an arbitrary origin, so the numbers stay small. */
const at = (startMinute: number, endMinute: number): Interval => ({
  start: startMinute * 60_000,
  end: endMinute * 60_000,
});

const minutes = (intervals: Interval[]): [number, number][] =>
  intervals.map((interval) => [interval.start / 60_000, interval.end / 60_000]);

describe('overlaps', () => {
  it('is false for intervals that merely touch', () => {
    // The half-open decision, asserted. An appointment ending at 10:00 and one
    // starting at 10:00 do not collide, and a calendar that says they do
    // refuses back-to-back bookings — which is what a busy salon does all day.
    expect(overlaps(at(540, 600), at(600, 660))).toBe(false);
  });

  it('is true for a single shared minute', () => {
    expect(overlaps(at(540, 601), at(600, 660))).toBe(true);
  });

  it('is false for an empty interval inside another', () => {
    expect(overlaps(at(570, 570), at(540, 600))).toBe(false);
  });
});

describe('contains', () => {
  it('accepts an interval flush with both edges', () => {
    expect(contains(at(540, 600), at(540, 600))).toBe(true);
  });

  it('rejects one that runs past the end', () => {
    expect(contains(at(540, 600), at(560, 601))).toBe(false);
  });
});

describe('intersect', () => {
  it('returns the shared part', () => {
    expect(intersect(at(540, 660), at(600, 720))).toEqual(at(600, 660));
  });

  it('returns nothing for touching intervals', () => {
    expect(intersect(at(540, 600), at(600, 660))).toBeUndefined();
  });
});

describe('normalise', () => {
  it('sorts, drops empties, and joins what overlaps', () => {
    expect(minutes(normalise([at(600, 660), at(540, 620), at(700, 700)]))).toEqual([[540, 660]]);
  });

  it('joins intervals that only touch', () => {
    // 09:00–12:00 and 12:00–17:00 is one working day. Left separate, a service
    // spanning noon becomes unbookable for a reason nobody could discover.
    expect(minutes(normalise([at(540, 720), at(720, 1020)]))).toEqual([[540, 1020]]);
  });

  it('keeps a real gap', () => {
    expect(minutes(normalise([at(540, 720), at(780, 1020)]))).toEqual([
      [540, 720],
      [780, 1020],
    ]);
  });

  it('swallows an interval entirely inside another', () => {
    expect(minutes(normalise([at(540, 1020), at(600, 660)]))).toEqual([[540, 1020]]);
  });
});

describe('subtract', () => {
  it('cuts a booking out of the middle of a working day', () => {
    expect(minutes(subtract([at(540, 1020)], [at(660, 720)]))).toEqual([
      [540, 660],
      [720, 1020],
    ]);
  });

  it('removes nothing when the busy interval only touches the edge', () => {
    expect(minutes(subtract([at(540, 1020)], [at(1020, 1080)]))).toEqual([[540, 1020]]);
  });

  it('handles several overlapping busy intervals at once', () => {
    expect(minutes(subtract([at(540, 1020)], [at(600, 700), at(660, 780), at(900, 1200)]))).toEqual(
      [
        [540, 600],
        [780, 900],
      ],
    );
  });

  it('returns nothing when the day is entirely taken', () => {
    expect(subtract([at(540, 1020)], [at(400, 1200)])).toEqual([]);
  });

  it('subtracts from each of a split shift independently', () => {
    expect(minutes(subtract([at(540, 720), at(840, 1080)], [at(600, 900)]))).toEqual([
      [540, 600],
      [900, 1080],
    ]);
  });

  it('is unchanged by an empty busy list', () => {
    expect(minutes(subtract([at(540, 1020)], []))).toEqual([[540, 1020]]);
  });
});

describe('intersectAll', () => {
  it('keeps only what both lists hold', () => {
    expect(minutes(intersectAll([at(540, 720), at(840, 1080)], [at(600, 900)]))).toEqual([
      [600, 720],
      [840, 900],
    ]);
  });

  it('advances the list that ends first, so nothing is skipped', () => {
    // The loop's one subtlety: a short interval on the left may meet several on
    // the right, and vice versa.
    expect(
      minutes(intersectAll([at(0, 1000)], [at(100, 200), at(300, 400), at(500, 600)])),
    ).toEqual([
      [100, 200],
      [300, 400],
      [500, 600],
    ]);
  });
});

describe('clamp and totalMinutes', () => {
  it('trims to the bounds', () => {
    expect(minutes(clamp([at(0, 2000)], at(540, 1020)))).toEqual([[540, 1020]]);
  });

  it('counts an overlap once', () => {
    expect(totalMinutes([at(540, 660), at(600, 720)])).toBe(180);
  });
});
