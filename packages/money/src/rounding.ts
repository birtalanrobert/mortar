/**
 * Rounding modes, matching the semantics of java.math.RoundingMode and of the
 * decimal rounding vocabulary most accountants use.
 */
export enum RoundingMode {
  /** Toward nearest; ties away from zero. The commercial default. */
  HalfUp = 'HALF_UP',
  /** Toward nearest; ties toward zero. */
  HalfDown = 'HALF_DOWN',
  /** Toward nearest; ties to the even neighbour. Banker's rounding. */
  HalfEven = 'HALF_EVEN',
  /** Away from zero. */
  Up = 'UP',
  /** Toward zero (truncate). */
  Down = 'DOWN',
  /** Toward positive infinity. */
  Ceiling = 'CEILING',
  /** Toward negative infinity. */
  Floor = 'FLOOR',
}

/**
 * The default rounding mode for this library.
 *
 * HalfUp rather than HalfEven, deliberately: these are commercial applications
 * issuing invoices and taking payments, and HalfUp is what the surrounding
 * paperwork, the tax authorities and the customer's own arithmetic will use.
 * Projects doing statistical aggregation can pass HalfEven explicitly.
 */
export const DEFAULT_ROUNDING: RoundingMode = RoundingMode.HalfUp;

/**
 * Rounds a real number to an integer under the given mode.
 *
 * Kept separate and pure so it can be unit-tested exhaustively against the
 * boundary cases (exact halves, negatives, zero) that rounding bugs hide in.
 */
export function roundToInteger(value: number, mode: RoundingMode = DEFAULT_ROUNDING): number {
  if (Number.isInteger(value)) return value;

  const floor = Math.floor(value);
  const remainder = value - floor; // always in (0, 1) here
  const isHalf = remainder === 0.5;

  switch (mode) {
    case RoundingMode.Ceiling:
      return floor + 1;
    case RoundingMode.Floor:
      return floor;
    case RoundingMode.Up:
      return value > 0 ? floor + 1 : floor;
    case RoundingMode.Down:
      return value > 0 ? floor : floor + 1;
    case RoundingMode.HalfUp:
      if (isHalf) return value > 0 ? floor + 1 : floor;
      return remainder > 0.5 ? floor + 1 : floor;
    case RoundingMode.HalfDown:
      if (isHalf) return value > 0 ? floor : floor + 1;
      return remainder > 0.5 ? floor + 1 : floor;
    case RoundingMode.HalfEven: {
      if (!isHalf) return remainder > 0.5 ? floor + 1 : floor;
      return floor % 2 === 0 ? floor : floor + 1;
    }
    default: {
      const exhaustive: never = mode;
      throw new Error(`Unsupported rounding mode: ${String(exhaustive)}`);
    }
  }
}
