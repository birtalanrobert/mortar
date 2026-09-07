import { describe, expect, it } from 'vitest';

import { instantOf } from './microsoft';

/**
 * The time arithmetic, which is the part that is wrong for a year.
 *
 * Graph returns a naive local time plus a zone *name* rather than an instant,
 * so a value parsed without applying the zone is however many hours out the
 * server happens to be — and it looks perfectly plausible on screen.
 */
const parse = instantOf;

describe('a Graph time', () => {
  it('reads a UTC value as the instant it is', () => {
    expect(parse('2026-06-15T09:00:00.0000000', 'UTC')).toBe(Date.UTC(2026, 5, 15, 9));
    expect(parse('2026-06-15T09:00:00Z')).toBe(Date.UTC(2026, 5, 15, 9));
  });

  it('applies a named zone rather than the server’s', () => {
    // Nine in Bucharest in June is six o'clock UTC. Parsed naively it would be
    // nine, and every appointment would be three hours out.
    expect(parse('2026-06-15T09:00:00.0000000', 'Europe/Bucharest')).toBe(Date.UTC(2026, 5, 15, 6));
  });

  it('gets the winter offset right too, which is the half that catches people', () => {
    // The same wall clock in January is seven o'clock UTC, not six.
    expect(parse('2026-01-15T09:00:00.0000000', 'Europe/Bucharest')).toBe(Date.UTC(2026, 0, 15, 7));
  });

  it('falls back to UTC for a zone name it does not know', () => {
    /*
     * An event in the wrong hour is better than a sync that stops: one calendar
     * with an odd zone must not take the whole thing down.
     */
    expect(parse('2026-06-15T09:00:00.0000000', 'Mars/Olympus')).toBe(Date.UTC(2026, 5, 15, 9));
  });
});
