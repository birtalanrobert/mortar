import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CALENDAR,
  addWorkingDays,
  heldSinceCutoff,
  isWorkingDay,
  workingDaysBetween,
  type WorkingCalendar,
} from './index';

const BUCHAREST: WorkingCalendar = {
  weekend: [0, 6],
  // Romania's first two of December 2026, and Christmas.
  holidays: ['2026-12-01', '2026-12-25'],
  timeZone: 'Europe/Bucharest',
};

describe('working days', () => {
  it('skips the weekend', () => {
    // Friday 6 March 2026 at 16:00, two working days, is Tuesday.
    const friday = new Date('2026-03-06T16:00:00Z');

    expect(addWorkingDays(friday, 2, DEFAULT_CALENDAR).toISOString()).toBe(
      '2026-03-10T16:00:00.000Z',
    );
  });

  it('keeps the time of day', () => {
    // A deadline snapped to midnight is either half a day early or half a day
    // late, and both get argued about at the counter.
    const afternoon = new Date('2026-03-02T15:30:00Z');

    expect(addWorkingDays(afternoon, 1, DEFAULT_CALENDAR).toISOString()).toBe(
      '2026-03-03T15:30:00.000Z',
    );
  });

  it('starts counting the day after', () => {
    // Monday, one working day, is Tuesday. The day it arrived is not a day of
    // work on it.
    const monday = new Date('2026-03-02T09:00:00Z');

    expect(addWorkingDays(monday, 1, DEFAULT_CALENDAR).toISOString()).toBe(
      '2026-03-03T09:00:00.000Z',
    );
  });

  it('skips a holiday in the calendar’s own zone', () => {
    // Monday 30 November 2026 → 1 December is a Romanian national holiday, so
    // one working day lands on Wednesday the 2nd.
    const monday = new Date('2026-11-30T09:00:00Z');

    expect(addWorkingDays(monday, 1, BUCHAREST).toISOString()).toBe('2026-12-02T09:00:00.000Z');
  });

  it('reads a holiday against local time, not UTC', () => {
    /*
     * The failure this prevents is invisible until somebody is chased a day
     * early. 22:30 UTC on 30 November is already 1 December in Bucharest — a
     * holiday — so a day counted from there must not treat that instant as a
     * working day.
     */
    const lateEvening = new Date('2026-11-30T22:30:00Z');

    expect(isWorkingDay(lateEvening, BUCHAREST)).toBe(false);
    expect(isWorkingDay(lateEvening, { ...BUCHAREST, timeZone: 'UTC' })).toBe(true);
  });

  it('honours a shop that works Saturdays and closes Mondays', () => {
    // Not exotic: assuming Saturday and Sunday is how a package becomes one a
    // real shop cannot use.
    const calendar: WorkingCalendar = { weekend: [0, 1], holidays: [], timeZone: 'UTC' };
    const saturday = new Date('2026-03-07T10:00:00Z');

    expect(isWorkingDay(saturday, calendar)).toBe(true);
    // Saturday + 1 skips Sunday and Monday, landing on Tuesday.
    expect(addWorkingDays(saturday, 1, calendar).toISOString()).toBe('2026-03-10T10:00:00.000Z');
  });

  it('counts backwards', () => {
    const wednesday = new Date('2026-03-11T09:00:00Z');

    expect(addWorkingDays(wednesday, -3, DEFAULT_CALENDAR).toISOString()).toBe(
      '2026-03-06T09:00:00.000Z',
    );
  });

  it('returns the same instant for zero', () => {
    const instant = new Date('2026-03-07T09:00:00Z');

    expect(addWorkingDays(instant, 0, DEFAULT_CALENDAR).toISOString()).toBe(instant.toISOString());
  });

  it('refuses a calendar with no working days rather than spinning', () => {
    // Reachable from a form with seven checkboxes, and the alternative is a
    // request that never returns.
    const closed: WorkingCalendar = {
      weekend: [0, 1, 2, 3, 4, 5, 6],
      holidays: [],
      timeZone: 'UTC',
    };

    expect(() => addWorkingDays(new Date('2026-03-02T09:00:00Z'), 1, closed)).toThrow(
      /no working days/,
    );
  });

  it('refuses a fraction', () => {
    expect(() => addWorkingDays(new Date(), 1.5)).toThrow(/whole number/);
  });

  describe('between two instants', () => {
    it('counts the later day and not the earlier', () => {
      expect(
        workingDaysBetween(
          new Date('2026-03-02T09:00:00Z'),
          new Date('2026-03-04T09:00:00Z'),
          DEFAULT_CALENDAR,
        ),
      ).toBe(2);
    });

    it('is zero across a weekend', () => {
      expect(
        workingDaysBetween(
          new Date('2026-03-07T09:00:00Z'),
          new Date('2026-03-08T09:00:00Z'),
          DEFAULT_CALENDAR,
        ),
      ).toBe(0);
    });

    it('is negative when the pair is reversed', () => {
      // The sign says which way round they were. A caller that silently got a
      // positive number from a reversed pair could not tell.
      expect(
        workingDaysBetween(
          new Date('2026-03-04T09:00:00Z'),
          new Date('2026-03-02T09:00:00Z'),
          DEFAULT_CALENDAR,
        ),
      ).toBe(-2);
    });

    it('round-trips with addWorkingDays', () => {
      const start = new Date('2026-11-27T14:00:00Z');
      const end = addWorkingDays(start, 5, BUCHAREST);

      expect(workingDaysBetween(start, end, BUCHAREST)).toBe(5);
    });
  });

  describe('held too long', () => {
    it('gives a cutoff a query can use', () => {
      // A cutoff rather than a predicate: `WHERE state_changed_at < $1` reaches
      // the index, and the predicate version stops working at the first shop
      // with a real backlog.
      const now = new Date('2026-03-11T09:00:00Z');

      expect(heldSinceCutoff(now, 3, DEFAULT_CALENDAR).toISOString()).toBe(
        '2026-03-06T09:00:00.000Z',
      );
    });

    it('counts nothing as now', () => {
      const now = new Date('2026-03-11T09:00:00Z');

      expect(heldSinceCutoff(now, 0, DEFAULT_CALENDAR).toISOString()).toBe(now.toISOString());
    });

    it('refuses a negative threshold', () => {
      expect(() => heldSinceCutoff(new Date(), -1)).toThrow(/cannot be negative/);
    });
  });
});
