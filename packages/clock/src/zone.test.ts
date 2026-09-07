import { describe, expect, it } from 'vitest';
import {
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
} from './zone';

const BUCHAREST = 'Europe/Bucharest';
const BUDAPEST = 'Europe/Budapest';

const iso = (instant: number): string => new Date(instant).toISOString();
const hm = (hour: number, minute = 0): number => hour * 60 + minute;

/**
 * The transitions, found rather than typed.
 *
 * Hard-coded dates would be a list somebody has to extend in 2031, and a list
 * that silently stops covering anything is worse than no list. The EU shifts on
 * the last Sunday of March and October; this finds the day whose length is not
 * twenty-four hours, which is true whatever the rule becomes.
 */
function transitionsIn(zone: string, year: number): { forward: LocalDate; back: LocalDate } {
  let forward = '';
  let back = '';

  for (let date = `${year}-01-01`; date < `${year + 1}-01-01`; date = addDays(date, 1)) {
    const shift = transitionMinutesOn(zone, date);
    if (shift > 0) forward = date;
    if (shift < 0) back = date;
  }

  return { forward, back };
}

describe('offsetMinutesAt', () => {
  it('reads winter and summer offsets for both markets', () => {
    expect(offsetMinutesAt(BUCHAREST, Date.parse('2026-01-15T12:00:00Z'))).toBe(120);
    expect(offsetMinutesAt(BUCHAREST, Date.parse('2026-07-15T12:00:00Z'))).toBe(180);
    expect(offsetMinutesAt(BUDAPEST, Date.parse('2026-01-15T12:00:00Z'))).toBe(60);
    expect(offsetMinutesAt(BUDAPEST, Date.parse('2026-07-15T12:00:00Z'))).toBe(120);
  });
});

describe('toInstant on an ordinary day', () => {
  it('resolves a winter morning in Bucharest', () => {
    const resolved = toInstant(BUCHAREST, '2026-01-15', hm(9));
    expect(iso(resolved.instant)).toBe('2026-01-15T07:00:00.000Z');
    expect(resolved.resolution).toBe('exact');
  });

  it('resolves the same wall clock in summer, an hour earlier in UTC', () => {
    // The whole reason the conversion is per date. "09:00 Monday" is not one
    // instant, and a fixed offset applied to a range is wrong for half the year.
    expect(iso(instantAt(BUCHAREST, '2026-07-15', hm(9)))).toBe('2026-07-15T06:00:00.000Z');
  });

  it('resolves an overnight window as one span, past minute 1440', () => {
    // A tattoo studio open 20:00–02:00 closes at minute 1560 of the day it
    // opened. Two rows that something must stitch together is the alternative.
    const open = instantAt(BUCHAREST, '2026-01-15', hm(20));
    const close = instantAt(BUCHAREST, '2026-01-15', hm(26));
    expect(iso(close)).toBe('2026-01-16T00:00:00.000Z');
    expect((close - open) / 3_600_000).toBe(6);
  });
});

/**
 * Five years, not one.
 *
 * The transition dates move — the last Sunday in March and October — and a
 * suite pinned to a single year proves the arithmetic for a set of dates that
 * stops being true in April. Five is the horizon a business actually books
 * into: an appointment made today can be next spring, and a rota set today runs
 * until somebody changes it.
 *
 * Read from `transitionsIn` rather than listed, so nothing here needs editing
 * when the years roll over — and so a change to the zone data is caught by the
 * assertions rather than by a fixture that agrees with it.
 */
const YEARS = [2026, 2027, 2028, 2029, 2030] as const;

describe('toInstant across the spring transition', () => {
  for (const [zone, missingHour] of [
    [BUCHAREST, 3],
    [BUDAPEST, 2],
  ] as const) {
    it.each(YEARS)(`reports the hour that does not exist in ${zone} as a gap, in %i`, (year) => {
      const { forward } = transitionsIn(zone, year);
      const resolved = toInstant(zone, forward, hm(missingHour, 30));

      expect(resolved.resolution).toBe('gap');
      // Shifted forward by exactly the hour that vanished, so 03:30 becomes
      // 04:30 rather than 04:00. A shift asked to run 03:30–11:00 then gets six
      // and a half real hours, because an hour of it did not exist; clamping to
      // the transition would hand back half an hour nobody worked.
      expect(localMinuteOfDay(zone, resolved.instant)).toBe(hm(missingHour + 1, 30));
    });

    it.each(YEARS)(`keeps the rest of that day exact in ${zone}, in %i`, (year) => {
      const { forward } = transitionsIn(zone, year);
      expect(toInstant(zone, forward, hm(9)).resolution).toBe('exact');
      expect(localMinuteOfDay(zone, instantAt(zone, forward, hm(9)))).toBe(hm(9));
    });

    it.each(YEARS)(`makes that day twenty-three hours long in ${zone}, in %i`, (year) => {
      const { forward } = transitionsIn(zone, year);
      const start = instantAt(zone, forward, 0);
      const end = instantAt(zone, addDays(forward, 1), 0);
      expect((end - start) / 3_600_000).toBe(23);
    });
  }
});

describe('toInstant across the autumn transition', () => {
  for (const [zone, repeatedHour] of [
    [BUCHAREST, 3],
    [BUDAPEST, 2],
  ] as const) {
    it.each(YEARS)(`reports the hour that happens twice in ${zone} as ambiguous, in %i`, (year) => {
      const { back } = transitionsIn(zone, year);
      const resolved = toInstant(zone, back, hm(repeatedHour, 30));
      expect(resolved.resolution).toBe('ambiguous');
    });

    it.each(YEARS)(`gives an hour between the two readings in ${zone}, in %i`, (year) => {
      const { back } = transitionsIn(zone, year);
      const earliest = instantAt(zone, back, hm(repeatedHour, 30), 'earliest');
      const latest = instantAt(zone, back, hm(repeatedHour, 30), 'latest');

      expect(latest - earliest).toBe(3_600_000);
      // Both are that wall clock; that is what makes it ambiguous.
      expect(localMinuteOfDay(zone, earliest)).toBe(hm(repeatedHour, 30));
      expect(localMinuteOfDay(zone, latest)).toBe(hm(repeatedHour, 30));
    });

    it.each(YEARS)(`makes that day twenty-five hours long in ${zone}, in %i`, (year) => {
      const { back } = transitionsIn(zone, year);
      const start = instantAt(zone, back, 0);
      const end = instantAt(zone, addDays(back, 1), 0);
      expect((end - start) / 3_600_000).toBe(25);
    });
  }

  it('keeps a studio open for the whole extra hour', () => {
    /*
     * The night the clocks go back is the night *before* the transition date:
     * the shift happens in the early hours, so a studio opening at 20:00 on the
     * previous evening is the one that works through it.
     *
     * Nine real hours between 20:00 and 04:00, not eight. Nothing here depends
     * on `prefer` — both ends are unambiguous — and that is worth asserting,
     * because it is the ordinary case and it must not need a special rule.
     */
    const { back } = transitionsIn(BUCHAREST, 2026);
    const evening = addDays(back, -1);
    const open = instantAt(BUCHAREST, evening, hm(20), 'earliest');
    const close = instantAt(BUCHAREST, evening, hm(28), 'latest');

    expect((close - open) / 3_600_000).toBe(9);
  });

  it('is why an end prefers the later reading', () => {
    /*
     * Where `prefer` actually decides something: a studio closing at 03:30,
     * which that night happens twice in Bucharest.
     *
     * The wall clock says seven and a half hours either way. `latest` keeps it
     * open through both readings of 03:30 — eight and a half real hours, which
     * is what the people inside experience. `earliest` closes at the first
     * 03:30 and loses the repeated hour, which nobody would find out about
     * until a customer arrived to a locked door.
     */
    const { back } = transitionsIn(BUCHAREST, 2026);
    const evening = addDays(back, -1);
    const open = instantAt(BUCHAREST, evening, hm(20), 'earliest');

    expect((instantAt(BUCHAREST, evening, hm(27, 30), 'latest') - open) / 3_600_000).toBe(8.5);
    expect((instantAt(BUCHAREST, evening, hm(27, 30), 'earliest') - open) / 3_600_000).toBe(7.5);
  });
});

/**
 * Five years, both markets, both transitions.
 *
 * The failure this guards against is silent and happens twice a year, which is
 * exactly the shape that survives a review and is found by a customer. Cheap to
 * assert over a range; impossible to notice by reading.
 */
describe('every transition in both markets for five years', () => {
  for (const zone of [BUCHAREST, BUDAPEST]) {
    for (let year = 2026; year <= 2030; year += 1) {
      it(`${zone} ${year}: both transitions are found and behave`, () => {
        const { forward, back } = transitionsIn(zone, year);

        expect(forward, 'a spring transition').toBeTruthy();
        expect(back, 'an autumn transition').toBeTruthy();
        expect(transitionMinutesOn(zone, forward)).toBe(60);
        expect(transitionMinutesOn(zone, back)).toBe(-60);

        // Every ordinary day in the year round-trips exactly at nine in the
        // morning, which is when most of these businesses open.
        for (const date of [`${year}-01-15`, `${year}-05-15`, `${year}-11-15`]) {
          const resolved = toInstant(zone, date, hm(9));
          expect(resolved.resolution, date).toBe('exact');
          expect(localMinuteOfDay(zone, resolved.instant), date).toBe(hm(9));
          expect(localDateOf(zone, resolved.instant), date).toBe(date);
        }
      });
    }
  }
});

describe('calendar arithmetic', () => {
  it('adds days across a month boundary', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('adds days across the spring transition without losing one', () => {
    // Calendar arithmetic, not time arithmetic. The day is 23 hours long and
    // the date still advances by one.
    const { forward } = transitionsIn(BUCHAREST, 2026);
    expect(daysBetween(forward, addDays(forward, 1))).toBe(1);
  });

  it('reads a weekday', () => {
    expect(weekdayOf('2026-09-04')).toBe(5);
    expect(weekdayOf('2026-09-06')).toBe(0);
  });

  it('rejects something that is not a date', () => {
    expect(() => addDays('the fourteenth', 1)).toThrow(/Not a date/);
  });
});

describe('localDateOf', () => {
  it('gives the date in the location’s reckoning, not the runtime’s', () => {
    // 23:30 UTC is already tomorrow in Bucharest. A product that used the
    // server's date here would file an appointment on the wrong day every
    // evening.
    const instant = Date.parse('2026-01-15T23:30:00Z');
    expect(localDateOf(BUCHAREST, instant)).toBe('2026-01-16');
    expect(localDateOf('Europe/London', instant)).toBe('2026-01-15');
  });
});
