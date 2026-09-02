import { InvalidMachine, type MachineDefinition, type Transition } from './definition';

export interface Machine<
  State extends string = string,
  Trigger extends string = string,
  Actor extends string = string,
> {
  readonly states: readonly State[];
  readonly initial: State;
  readonly terminal: readonly State[];
  readonly transitions: readonly Transition<State, Trigger, Actor>[];
  readonly dueBearing: readonly State[];

  isState(value: string): value is State;
  isTerminal(state: State): boolean;

  /** The move, if this actor may make it from here. */
  transitionFor(
    from: State,
    trigger: Trigger,
    by: Actor,
  ): Transition<State, Trigger, Actor> | undefined;
  can(from: State, trigger: Trigger, by: Actor): boolean;

  /** Everything this actor may do from here — what a screen renders as buttons. */
  available(from: State, by: Actor): readonly Transition<State, Trigger, Actor>[];

  /**
   * Whether a due date has passed *and still means anything*.
   *
   * Both halves matter. A subject past its date in a state that does not bear
   * one is not late, it is paused, and reporting it as late is how a firm stops
   * believing the number.
   */
  isPastDue(state: State, dueAt: Date | null | undefined, now: Date): boolean;
}

/**
 * Builds a machine, or refuses.
 *
 * Validation is not a nicety here. One consumer assembles this table from
 * database rows a shop owner edited, and the failures below are the ones that
 * produce a lifecycle nobody can get out of — discovered by a customer whose
 * device is stuck in a state with no exit, on a Saturday.
 */
export function defineMachine<State extends string, Trigger extends string, Actor extends string>(
  definition: MachineDefinition<State, Trigger, Actor>,
): Machine<State, Trigger, Actor> {
  const states = new Set<string>(definition.states);
  const terminal = new Set<string>(definition.terminal);
  const problems: string[] = [];

  if (definition.states.length === 0) problems.push('there are no states');

  const duplicateStates = definition.states.filter(
    (state, index) => definition.states.indexOf(state) !== index,
  );
  for (const state of new Set(duplicateStates)) {
    problems.push(`the state '${state}' is listed more than once`);
  }

  for (const state of definition.terminal) {
    if (!states.has(state)) problems.push(`'${state}' is terminal but is not a state`);
  }

  if (!states.has(definition.initial)) {
    problems.push(`the initial state '${definition.initial}' is not a state`);
  } else if (terminal.has(definition.initial)) {
    problems.push(
      `the initial state '${definition.initial}' is also terminal, so nothing can happen`,
    );
  }

  const seen = new Set<string>();
  for (const transition of definition.transitions) {
    const where = `${transition.from} --${transition.trigger}--> ${transition.to}`;

    if (!states.has(transition.from))
      problems.push(`${where}: '${transition.from}' is not a state`);
    if (!states.has(transition.to)) problems.push(`${where}: '${transition.to}' is not a state`);
    if (transition.by.length === 0) problems.push(`${where}: nobody may make this move`);

    /*
     * A terminal state is the definition of "nothing further happens". A
     * transition out of one is a contradiction, and the honest way out of a
     * state entered by mistake is a *reversal* — which is recorded as one.
     */
    if (terminal.has(transition.from)) {
      problems.push(`${where}: '${transition.from}' is terminal, so nothing may lead out of it`);
    }

    for (const actor of transition.by) {
      const key = `${transition.from}|${transition.trigger}|${actor}`;
      if (seen.has(key)) {
        problems.push(
          `${where}: '${actor}' already has a '${transition.trigger}' from '${transition.from}', ` +
            'so which one applies would be decided by table order',
        );
      }
      seen.add(key);
    }
  }

  /*
   * A non-terminal state with no way out is a trap, and it is the single most
   * likely mistake in a table somebody edited: a state added, wired up going in,
   * and never wired up coming out.
   */
  for (const state of definition.states) {
    if (terminal.has(state)) continue;
    if (!definition.transitions.some((transition) => transition.from === state)) {
      problems.push(
        `'${state}' is not terminal but has no way out, so anything reaching it is stuck`,
      );
    }
  }

  // Unreachable states are dead vocabulary: they appear in reports and filters
  // and never hold anything, which sends people looking for the bug that is
  // hiding them.
  const reachable = new Set<string>([definition.initial]);
  for (let changed = true; changed;) {
    changed = false;
    for (const transition of definition.transitions) {
      if (reachable.has(transition.from) && !reachable.has(transition.to)) {
        reachable.add(transition.to);
        changed = true;
      }
    }
  }
  for (const state of definition.states) {
    if (!reachable.has(state)) {
      problems.push(`'${state}' cannot be reached from '${definition.initial}'`);
    }
  }

  const dueBearing =
    definition.dueBearing ??
    definition.states.filter((state) => !terminal.has(state) && state !== definition.initial);

  for (const state of dueBearing) {
    if (!states.has(state)) problems.push(`'${state}' bears a due date but is not a state`);
    else if (terminal.has(state)) {
      problems.push(
        `'${state}' is terminal and bears a due date, so a finished subject could be reported late`,
      );
    }
  }

  if (problems.length > 0) throw new InvalidMachine(problems);

  const transitions = definition.transitions;

  return {
    states: definition.states,
    initial: definition.initial,
    terminal: definition.terminal,
    transitions,
    dueBearing,

    isState: (value): value is State => states.has(value),
    isTerminal: (state) => terminal.has(state),

    transitionFor: (from, trigger, by) =>
      transitions.find(
        (transition) =>
          transition.from === from && transition.trigger === trigger && transition.by.includes(by),
      ),

    can(from, trigger, by) {
      return this.transitionFor(from, trigger, by) !== undefined;
    },

    available: (from, by) =>
      transitions.filter((transition) => transition.from === from && transition.by.includes(by)),

    isPastDue(state, dueAt, now) {
      if (!dueAt) return false;
      if (!dueBearing.includes(state)) return false;
      return dueAt.getTime() < now.getTime();
    },
  };
}
