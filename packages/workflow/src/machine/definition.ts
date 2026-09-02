/**
 * A lifecycle expressed as data.
 *
 * The table is a **value**, not a type-level construction, and that is the
 * decision the whole module rests on. Its two consumers need different things:
 * one holds its lifecycle in code, where the states are a literal union the
 * compiler checks exhaustively; the other holds it in a database row, because a
 * bicycle workshop and a watchmaker do not share a workflow and neither should
 * have to wait for a deployment to change theirs.
 *
 * A package that assumed either shape would be wrong for the other. Taking a
 * value and validating it at construction serves both — and the validation is
 * what makes the configurable case safe, because a table assembled from rows is
 * user input.
 */

/** One legal move. */
export interface Transition<
  State extends string = string,
  Trigger extends string = string,
  Actor extends string = string,
> {
  readonly from: State;
  readonly to: State;
  readonly trigger: Trigger;
  /**
   * Who may do it.
   *
   * A list rather than a single actor, because the same move is frequently
   * available to more than one — a client submitting the last document and a
   * sweep noticing they already have are the same transition, and modelling
   * them separately means two rows that must be kept in step forever.
   */
  readonly by: readonly Actor[];
}

export interface MachineDefinition<
  State extends string = string,
  Trigger extends string = string,
  Actor extends string = string,
> {
  readonly states: readonly State[];
  /** Where a subject starts. Must not be terminal — that is a lifecycle with no life. */
  readonly initial: State;
  /** States from which nothing further happens, except a recorded reversal. */
  readonly terminal: readonly State[];
  readonly transitions: readonly Transition<State, Trigger, Actor>[];
  /**
   * States in which a due date still means something. Defaults to every
   * non-terminal state other than the initial one.
   *
   * The default is the useful one and the reasoning generalises: a subject that
   * has not been started yet has a *plan* rather than a promise, and one that
   * has finished cannot become late afterwards. A lifecycle with a state that
   * suspends the clock — on hold, awaiting parts, waiting on a third party —
   * sets this explicitly, because a chasing list that counts those is a list
   * the people using it learn to ignore.
   */
  readonly dueBearing?: readonly State[];
}

/**
 * Everything wrong with a definition, at once.
 *
 * All of them rather than the first, because a table assembled from rows is
 * edited by a person who would otherwise fix one problem, save, and be told
 * about the next.
 */
export class InvalidMachine extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`This lifecycle cannot be used:\n  ${problems.join('\n  ')}`);
    this.name = 'InvalidMachine';
  }
}
