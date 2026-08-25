import { describe, expect, it } from 'vitest';
import { RoundingMode, roundToInteger } from './rounding';

/**
 * Rounding bugs hide in exact halves, in negatives, and in the difference
 * between "away from zero" and "toward positive infinity". Every mode is
 * therefore checked against both signs and against an exact half.
 */
describe('roundToInteger', () => {
  const cases: Array<[RoundingMode, number, number]> = [
    [RoundingMode.HalfUp, 2.5, 3],
    [RoundingMode.HalfUp, 3.5, 4],
    [RoundingMode.HalfUp, -2.5, -3],
    [RoundingMode.HalfUp, 2.4, 2],
    [RoundingMode.HalfUp, 2.6, 3],

    [RoundingMode.HalfDown, 2.5, 2],
    [RoundingMode.HalfDown, -2.5, -2],
    [RoundingMode.HalfDown, 2.6, 3],

    [RoundingMode.HalfEven, 2.5, 2],
    [RoundingMode.HalfEven, 3.5, 4],
    [RoundingMode.HalfEven, -2.5, -2],
    [RoundingMode.HalfEven, -3.5, -4],
    [RoundingMode.HalfEven, 2.4, 2],

    [RoundingMode.Up, 2.1, 3],
    [RoundingMode.Up, -2.1, -3],

    [RoundingMode.Down, 2.9, 2],
    [RoundingMode.Down, -2.9, -2],

    [RoundingMode.Ceiling, 2.1, 3],
    [RoundingMode.Ceiling, -2.9, -2],

    [RoundingMode.Floor, 2.9, 2],
    [RoundingMode.Floor, -2.1, -3],
  ];

  it.each(cases)('%s rounds %d to %d', (mode, input, expected) => {
    expect(roundToInteger(input, mode)).toBe(expected);
  });

  it('leaves integers untouched under every mode', () => {
    for (const mode of Object.values(RoundingMode)) {
      expect(roundToInteger(7, mode)).toBe(7);
      expect(roundToInteger(-7, mode)).toBe(-7);
      expect(roundToInteger(0, mode)).toBe(0);
    }
  });
});
