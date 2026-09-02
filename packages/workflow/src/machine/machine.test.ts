import { describe, expect, it } from 'vitest';
import { InvalidMachine, defineMachine, type MachineDefinition } from './index';

type State = 'draft' | 'sent' | 'working' | 'review' | 'done' | 'cancelled';
type Trigger = 'send' | 'start' | 'submit' | 'accept' | 'reject' | 'cancel';
type Actor = 'staff' | 'client' | 'system';

const LIFECYCLE: MachineDefinition<State, Trigger, Actor> = {
  states: ['draft', 'sent', 'working', 'review', 'done', 'cancelled'],
  initial: 'draft',
  terminal: ['done', 'cancelled'],
  transitions: [
    { from: 'draft', to: 'sent', trigger: 'send', by: ['staff'] },
    { from: 'sent', to: 'working', trigger: 'start', by: ['client', 'system'] },
    { from: 'working', to: 'review', trigger: 'submit', by: ['client', 'system'] },
    { from: 'review', to: 'working', trigger: 'reject', by: ['staff'] },
    { from: 'review', to: 'done', trigger: 'accept', by: ['staff'] },
    { from: 'draft', to: 'cancelled', trigger: 'cancel', by: ['staff'] },
    { from: 'sent', to: 'cancelled', trigger: 'cancel', by: ['staff'] },
    { from: 'working', to: 'cancelled', trigger: 'cancel', by: ['staff'] },
    { from: 'review', to: 'cancelled', trigger: 'cancel', by: ['staff'] },
  ],
};

describe('a lifecycle', () => {
  const machine = defineMachine(LIFECYCLE);

  it('permits a move only to the actor the table names', () => {
    expect(machine.can('draft', 'send', 'staff')).toBe(true);

    // The same trigger, from the same state, by somebody the table does not
    // name. This is the check that makes the table an authorisation boundary
    // rather than documentation.
    expect(machine.can('draft', 'send', 'client')).toBe(false);
  });

  it('refuses a move that is legal from somewhere else', () => {
    expect(machine.can('draft', 'accept', 'staff')).toBe(false);
  });

  it('offers an actor exactly what they may do from here', () => {
    expect(
      machine
        .available('review', 'staff')
        .map((one) => one.to)
        .sort(),
    ).toEqual(['cancelled', 'done', 'working']);

    // A client may do nothing from review; they have already submitted.
    expect(machine.available('review', 'client')).toEqual([]);
  });

  it('knows where nothing further happens', () => {
    expect(machine.isTerminal('done')).toBe(true);
    expect(machine.isTerminal('working')).toBe(false);
    expect(machine.available('done', 'staff')).toEqual([]);
  });

  it('bears a due date only where one means something', () => {
    const due = new Date('2026-03-02T09:00:00Z');
    const later = new Date('2026-03-03T09:00:00Z');

    expect(machine.isPastDue('working', due, later)).toBe(true);

    // Not yet sent: the date is a plan rather than a promise.
    expect(machine.isPastDue('draft', due, later)).toBe(false);

    // Finished. A completed subject cannot become late afterwards, and counting
    // it teaches everyone to ignore the number.
    expect(machine.isPastDue('done', due, later)).toBe(false);

    expect(machine.isPastDue('working', null, later)).toBe(false);
  });

  it('lets a lifecycle suspend the clock in a named state', () => {
    const withHold = defineMachine<State | 'held', Trigger | 'hold' | 'resume', Actor>({
      ...LIFECYCLE,
      states: [...LIFECYCLE.states, 'held'],
      transitions: [
        ...LIFECYCLE.transitions,
        { from: 'working', to: 'held', trigger: 'hold', by: ['staff'] },
        { from: 'held', to: 'working', trigger: 'resume', by: ['staff'] },
      ],
      // Everything in flight except `held` — a subject waiting on the shop is
      // not a subject the client is late on.
      dueBearing: ['sent', 'working', 'review'],
    });

    const due = new Date('2026-03-02T09:00:00Z');
    const later = new Date('2026-03-09T09:00:00Z');

    expect(withHold.isPastDue('working', due, later)).toBe(true);
    expect(withHold.isPastDue('held', due, later)).toBe(false);
  });
});

describe('a lifecycle that cannot be used', () => {
  /*
   * Every case below is reachable by a shop owner editing a table in a form.
   * That is why these throw rather than warn: the alternative to refusing a
   * broken lifecycle at construction is discovering it as a device nobody can
   * move, on a Saturday, with a customer waiting.
   */
  const build = (definition: Partial<MachineDefinition<string, string, string>>) => () =>
    defineMachine({
      states: ['a', 'b'],
      initial: 'a',
      terminal: ['b'],
      transitions: [{ from: 'a', to: 'b', trigger: 'go', by: ['staff'] }],
      ...definition,
    });

  const problemsOf = (build: () => unknown): readonly string[] => {
    try {
      build();
    } catch (error) {
      if (error instanceof InvalidMachine) return error.problems;
      throw error;
    }
    throw new Error('expected this lifecycle to be refused');
  };

  it('refuses a state nothing can leave', () => {
    expect(
      problemsOf(
        build({
          states: ['a', 'b', 'stuck'],
          transitions: [
            { from: 'a', to: 'b', trigger: 'go', by: ['staff'] },
            { from: 'a', to: 'stuck', trigger: 'park', by: ['staff'] },
          ],
        }),
      ),
    ).toContainEqual(expect.stringContaining("'stuck' is not terminal but has no way out"));
  });

  it('refuses a state nothing can reach', () => {
    expect(
      problemsOf(
        build({
          states: ['a', 'b', 'orphan'],
          terminal: ['b', 'orphan'],
        }),
      ),
    ).toContainEqual(expect.stringContaining("'orphan' cannot be reached"));
  });

  it('refuses a way out of a terminal state', () => {
    // The honest way out of a state entered by mistake is a *reversal*, which
    // is recorded as one. A transition would erase the mistake instead.
    expect(
      problemsOf(
        build({
          transitions: [
            { from: 'a', to: 'b', trigger: 'go', by: ['staff'] },
            { from: 'b', to: 'a', trigger: 'undo', by: ['staff'] },
          ],
        }),
      ),
    ).toContainEqual(expect.stringContaining("'b' is terminal, so nothing may lead out of it"));
  });

  it('refuses two moves that would race on table order', () => {
    expect(
      problemsOf(
        build({
          states: ['a', 'b', 'c'],
          terminal: ['b', 'c'],
          transitions: [
            { from: 'a', to: 'b', trigger: 'go', by: ['staff'] },
            { from: 'a', to: 'c', trigger: 'go', by: ['staff'] },
          ],
        }),
      ),
    ).toContainEqual(expect.stringContaining('decided by table order'));
  });

  it('allows the same trigger for different actors, going different places', () => {
    // Not a conflict: a client's "cancel" and a member of staff's "cancel" may
    // legitimately mean different things, and nothing is ambiguous because the
    // actor decides.
    expect(() =>
      defineMachine({
        states: ['a', 'withdrawn', 'refused'],
        initial: 'a',
        terminal: ['withdrawn', 'refused'],
        transitions: [
          { from: 'a', to: 'withdrawn', trigger: 'cancel', by: ['client'] },
          { from: 'a', to: 'refused', trigger: 'cancel', by: ['staff'] },
        ],
      }),
    ).not.toThrow();
  });

  it('refuses a lifecycle with no life', () => {
    expect(problemsOf(build({ initial: 'b' }))).toContainEqual(
      expect.stringContaining('is also terminal, so nothing can happen'),
    );
  });

  it('refuses a move nobody may make', () => {
    expect(
      problemsOf(build({ transitions: [{ from: 'a', to: 'b', trigger: 'go', by: [] }] })),
    ).toContainEqual(expect.stringContaining('nobody may make this move'));
  });

  it('refuses a due date on a finished subject', () => {
    expect(problemsOf(build({ dueBearing: ['b'] }))).toContainEqual(
      expect.stringContaining('could be reported late'),
    );
  });

  it('reports every problem at once', () => {
    // A table edited in a form is fixed one save at a time, and being told
    // about the next problem after each save is how somebody gives up.
    const problems = problemsOf(
      build({
        states: ['a', 'b', 'stuck', 'orphan'],
        terminal: ['b'],
        transitions: [
          { from: 'a', to: 'b', trigger: 'go', by: ['staff'] },
          { from: 'a', to: 'stuck', trigger: 'park', by: [] },
        ],
      }),
    );

    expect(problems.length).toBeGreaterThanOrEqual(3);
  });

  it('names the state that is not a state', () => {
    expect(
      problemsOf(build({ transitions: [{ from: 'a', to: 'typo', trigger: 'go', by: ['staff'] }] })),
    ).toContainEqual(expect.stringContaining("'typo' is not a state"));
  });
});
