import { decimal, isMoreThanZero, type Decimal } from './decimal';

/**
 * One unit, and how much of the base unit it is.
 *
 * Either **absolutely** (`toBase`) or **relative to another unit** (`of` and
 * `times`). The second form is the one people actually speak: a case is four
 * trays, a tray is six bottles, and nobody in a warehouse knows or cares that a
 * case is twenty-four bottles until they are asked.
 */
export interface UnitSpec {
  readonly code: string;
  /** How many base units one of these is. Exclusive with `of`/`times`. */
  readonly toBase?: Decimal | string | number;
  /** The unit this one is defined in terms of. */
  readonly of?: string;
  /** How many of `of` this one is. */
  readonly times?: Decimal | string | number;
}

/** Why a unit table could not be built. */
export interface UnitTableProblem {
  readonly reason: 'duplicate' | 'unknown-parent' | 'cycle' | 'not-positive' | 'missing-base';
  readonly unit: string;
  /** A sentence a person can act on, naming the units involved. */
  readonly says: string;
}

/**
 * A table that could not be built, with the reason attached.
 *
 * Thrown rather than returned, because a broken table is a broken definition —
 * and a definition is either a programmer's or a row of somebody's import file.
 * The first should fail loudly at boot; the second is caught by the importer and
 * becomes a row problem with a line number, which is why `problem` is
 * structured rather than only a message.
 */
export class UnitTableError extends Error {
  readonly problem: UnitTableProblem;

  constructor(problem: UnitTableProblem) {
    super(problem.says);
    this.name = 'UnitTableError';
    this.problem = problem;
  }
}

/**
 * The units one thing can be counted in, and what each is worth.
 *
 * Immutable, and **every factor is absolute by the time anybody can read one**.
 * That is the whole design: the chain is walked once, at definition, so no
 * lookup at conversion time can loop and no caller can construct a table whose
 * answer depends on the order it asks its questions in.
 */
export interface UnitTable {
  /** The unit every factor is expressed in. Its own factor is exactly 1. */
  readonly base: string;
  /** Every code in the table, in the order they were defined. */
  readonly codes: readonly string[];
  /** How many base units one of `code` is, or `undefined` if it is not here. */
  factor(code: string): Decimal | undefined;
  has(code: string): boolean;
}

/**
 * Builds a table by resolving every chain to an absolute factor, once.
 *
 * **A cycle is impossible by construction rather than by checking at use.** The
 * resolution below walks each definition to the base and refuses when it meets
 * a unit it is already resolving — so `case → tray → case` fails here, naming
 * the loop, and never at two in the morning inside an order total.
 *
 * The base unit does not have to be declared: it is implied, its factor is 1,
 * and declaring it with a factor of anything else is refused, because a base
 * unit that is 1.0 of itself is the only thing "base" can mean.
 */
export function unitTable(units: readonly UnitSpec[], options: { base: string }): UnitTable {
  const base = options.base;
  const byCode = new Map<string, UnitSpec>();

  for (const unit of units) {
    if (byCode.has(unit.code)) {
      throw new UnitTableError({
        reason: 'duplicate',
        unit: unit.code,
        says: `"${unit.code}" is defined twice, and the two definitions disagree about what it is worth.`,
      });
    }
    byCode.set(unit.code, unit);
  }

  const resolved = new Map<string, Decimal>([[base, decimal(1)]]);

  const declaredBase = byCode.get(base);
  if (declaredBase) {
    const direct = declaredBase.toBase ?? declaredBase.times;
    if (direct !== undefined && !decimal(direct).equals(1)) {
      throw new UnitTableError({
        reason: 'missing-base',
        unit: base,
        says: `"${base}" is the base unit, so it is worth exactly 1 of itself.`,
      });
    }
  }

  const resolving = new Set<string>();

  const resolve = (code: string, trail: readonly string[]): Decimal => {
    const known = resolved.get(code);
    if (known) return known;

    if (resolving.has(code)) {
      throw new UnitTableError({
        reason: 'cycle',
        unit: code,
        says: `"${code}" is defined in terms of itself: ${[...trail, code].join(' → ')}.`,
      });
    }

    const spec = byCode.get(code);
    if (!spec) {
      throw new UnitTableError({
        reason: 'unknown-parent',
        unit: code,
        says: `"${trail.at(-1) ?? code}" is defined in terms of "${code}", which is not in this table.`,
      });
    }

    resolving.add(code);

    let factor: Decimal;
    if (spec.toBase !== undefined) {
      factor = decimal(spec.toBase);
    } else if (spec.of !== undefined) {
      factor = decimal(spec.times ?? 1).times(resolve(spec.of, [...trail, code]));
    } else {
      throw new UnitTableError({
        reason: 'not-positive',
        unit: code,
        says: `"${code}" says neither how many ${base} it is nor what it is made of.`,
      });
    }

    resolving.delete(code);

    if (!isMoreThanZero(factor)) {
      /*
       * Zero and negative are both refused, and zero is the one worth naming:
       * a unit worth nothing divides by zero the first time somebody converts
       * *out* of the base, which surfaces as Infinity in a total rather than as
       * an error anybody can trace back to a definition.
       */
      throw new UnitTableError({
        reason: 'not-positive',
        unit: code,
        says: `"${code}" is worth ${factor.toString()} ${base}, which is not an amount of anything.`,
      });
    }

    resolved.set(code, factor);
    return factor;
  };

  for (const unit of units) resolve(unit.code, []);

  const codes = Object.freeze([
    base,
    ...units.map((unit) => unit.code).filter((code) => code !== base),
  ]);

  return Object.freeze({
    base,
    codes,
    factor: (code: string) => resolved.get(code),
    has: (code: string) => resolved.has(code),
  });
}
