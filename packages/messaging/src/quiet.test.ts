import { describe, expect, it } from 'vitest';
import { isQuiet, localTime, nextAllowed } from './quiet';

const quiet = { from: 19, to: 9, timezone: 'Europe/Bucharest' };

describe('localTime', () => {
  it('reads the hour in the zone asked for, not the machine’s', () => {
    // A server in UTC and a firm in Bucharest disagree by three hours in
    // summer, and the whole point of quiet hours is the firm's clock.
    expect(localTime(new Date('2026-08-09T18:30:00Z'), 'Europe/Bucharest')).toEqual({
      hour: 21,
      minute: 30,
    });
    expect(localTime(new Date('2026-08-09T18:30:00Z'), 'UTC')).toEqual({ hour: 18, minute: 30 });
  });

  it('follows the zone across a daylight-saving change', () => {
    // Two hours in January, three in August. A cadence configured in summer
    // must not start chasing an hour early in winter.
    expect(localTime(new Date('2026-01-09T18:00:00Z'), 'Europe/Bucharest').hour).toBe(20);
    expect(localTime(new Date('2026-08-09T18:00:00Z'), 'Europe/Bucharest').hour).toBe(21);
  });
});

describe('isQuiet', () => {
  it('covers the evening and the night as one window', () => {
    // 19:00 to 09:00 wraps midnight, which is the normal shape and the one
    // that a naive `from <= hour && hour < to` gets exactly backwards.
    expect(isQuiet(new Date('2026-08-09T17:00:00Z'), quiet)).toBe(true); // 20:00 local
    expect(isQuiet(new Date('2026-08-09T23:00:00Z'), quiet)).toBe(true); // 02:00 local
    expect(isQuiet(new Date('2026-08-09T05:00:00Z'), quiet)).toBe(true); // 08:00 local
  });

  it('lets the working day through', () => {
    expect(isQuiet(new Date('2026-08-09T06:00:00Z'), quiet)).toBe(false); // 09:00 local
    expect(isQuiet(new Date('2026-08-09T14:00:00Z'), quiet)).toBe(false); // 17:00 local
  });

  it('handles a window that does not wrap', () => {
    // A firm could configure quiet from 01:00 to 06:00. Unusual, and it must
    // not be read as "quiet all day except those five hours".
    const narrow = { from: 1, to: 6, timezone: 'UTC' };
    expect(isQuiet(new Date('2026-08-09T03:00:00Z'), narrow)).toBe(true);
    expect(isQuiet(new Date('2026-08-09T12:00:00Z'), narrow)).toBe(false);
  });
});

describe('nextAllowed', () => {
  it('returns the instant itself when it is already fine', () => {
    const at = new Date('2026-08-09T10:00:00Z');
    expect(nextAllowed(at, quiet)).toEqual(at);
  });

  it('waits for the working day to start', () => {
    // 02:00 local on the 10th → 09:00 local, which is 06:00 UTC.
    expect(nextAllowed(new Date('2026-08-09T23:00:00Z'), quiet)).toEqual(
      new Date('2026-08-10T06:00:00Z'),
    );
  });

  it('gives up rather than looping when every hour is quiet', () => {
    const always = { from: 9, to: 9, timezone: 'UTC' };
    const at = new Date('2026-08-09T12:00:00Z');

    // A firm can configure this by mistake. A reminder at an awkward hour is
    // recoverable; a request that is never chased at all is the thing the
    // product was bought to prevent.
    expect(nextAllowed(at, always)).toEqual(at);
  });
});
