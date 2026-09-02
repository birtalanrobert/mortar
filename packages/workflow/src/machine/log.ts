import type { EntityManager, EntityTarget } from 'typeorm';
import type { Machine } from './machine';
import type { TransitionLogEntity } from './log.entity';

/** Refused because the lifecycle does not allow it. */
export class TransitionRefused extends Error {
  constructor(
    readonly from: string,
    readonly trigger: string,
    readonly actorType: string,
    readonly available: readonly string[],
  ) {
    super(
      `'${actorType}' cannot '${trigger}' from '${from}'. ` +
        (available.length > 0
          ? `Available: ${available.join(', ')}.`
          : 'Nothing is available to them from there.'),
    );
    this.name = 'TransitionRefused';
  }
}

export interface Move<Trigger extends string, Actor extends string> {
  readonly subjectId: string;
  readonly tenantId: string;
  readonly from: string | null;
  readonly trigger: Trigger;
  /** Who, by name or identifier — never an empty string. */
  readonly actor: string;
  readonly actorType: Actor;
  readonly reason?: string;
  readonly detail?: Record<string, unknown>;
}

export interface Reversal<Actor extends string> {
  readonly subjectId: string;
  readonly tenantId: string;
  readonly actor: string;
  readonly actorType: Actor;
  /** Required. A reversal with no reason is unexplained rewriting of history. */
  readonly reason: string;
}

export interface Recorded {
  readonly id: string;
  readonly from: string | null;
  readonly to: string;
}

/**
 * Applies moves to a lifecycle and writes down what happened.
 *
 * **Takes the caller's `EntityManager` on every call, and never opens a
 * transaction of its own.** The move and its log entry have to commit together
 * or not at all — a subject whose state advanced without a log entry is a
 * subject whose history has a hole in it, and a log entry for a move that
 * rolled back is worse.
 *
 * It does not write the subject. The product owns its own table and knows what
 * else changes when a ticket is collected; this owns the decision about whether
 * the move is allowed, and the record that it happened.
 */
export class TransitionLog<
  State extends string = string,
  Trigger extends string = string,
  Actor extends string = string,
> {
  constructor(
    private readonly machine: Machine<State, Trigger, Actor>,
    private readonly entity: EntityTarget<TransitionLogEntity>,
  ) {}

  /**
   * Checks the move, records it, and answers with the state to write.
   *
   * Throws `TransitionRefused` rather than returning a result, because every
   * caller would otherwise have to remember to check — and the one that forgets
   * writes an illegal state that the log then vouches for.
   */
  async record(manager: EntityManager, move: Move<Trigger, Actor>): Promise<Recorded> {
    const from = move.from;

    if (from === null) {
      /*
       * The opening move, which always lands on the lifecycle's initial state.
       *
       * There is no transition row to consult — nothing preceded it — so what
       * is enforced instead is the destination. A subject created directly into
       * the middle of its lifecycle has skipped everything that should have
       * happened first, and no later query can tell that it did.
       */
      return this.write(manager, move, null, this.machine.initial);
    }

    if (!this.machine.isState(from)) {
      throw new TransitionRefused(from, move.trigger, move.actorType, []);
    }

    const transition = this.machine.transitionFor(from, move.trigger, move.actorType);
    if (!transition) {
      throw new TransitionRefused(
        from,
        move.trigger,
        move.actorType,
        this.machine.available(from, move.actorType).map((one) => one.trigger),
      );
    }

    return this.write(manager, move, from, transition.to);
  }

  /**
   * Undoes the last move, and says so.
   *
   * The only way out of a terminal state, and deliberately narrow: it returns
   * the subject to the state immediately before its current one, and nowhere
   * else. A reversal that could reach any state is an edit, and an edit to a
   * lifecycle is indistinguishable from a mistake being covered up.
   *
   * Three things it refuses:
   *
   * - a reversal with no reason, because that is the whole point of recording
   *   one rather than deleting a row;
   * - reversing a reversal, which oscillates and means nothing — going forward
   *   again is an ordinary move, and should look like one in the history;
   * - reversing the opening move, because there is no state to return to.
   *
   * Authorisation is the caller's: the lifecycle knows nothing about
   * permissions, and "an owner may reverse" is a decision products make
   * differently.
   */
  async reverse(manager: EntityManager, reversal: Reversal<Actor>): Promise<Recorded> {
    if (!reversal.reason?.trim()) {
      throw new TransitionRefused('', 'reverse', reversal.actorType, []);
    }

    const [last] = await manager.find(this.entity, {
      where: { subjectId: reversal.subjectId, tenantId: reversal.tenantId },
      order: { occurredAt: 'DESC', id: 'DESC' },
      take: 1,
    });

    if (!last) {
      throw new Error(`Nothing has happened to ${reversal.subjectId}, so nothing can be reversed`);
    }

    if (last.reverses) {
      throw new Error(
        'That was itself a reversal. Move forward with an ordinary transition rather than ' +
          'reversing a reversal, so the history reads as what happened.',
      );
    }

    if (last.fromState === null) {
      throw new Error('That was the first thing that happened; there is no state to return to.');
    }

    const repository = manager.getRepository(this.entity);
    const row = repository.create({
      tenantId: reversal.tenantId,
      subjectId: reversal.subjectId,
      fromState: last.toState,
      toState: last.fromState,
      trigger: 'reverse',
      actor: reversal.actor,
      actorType: reversal.actorType,
      reason: reversal.reason,
      reverses: last.id,
      detail: null,
    });
    await repository.save(row);

    return { id: row.id, from: last.toState, to: last.fromState };
  }

  /** Oldest first — the order somebody reads a history in. */
  async history(
    manager: EntityManager,
    subjectId: string,
    tenantId: string,
  ): Promise<TransitionLogEntity[]> {
    return manager.find(this.entity, {
      where: { subjectId, tenantId },
      order: { occurredAt: 'ASC', id: 'ASC' },
    });
  }

  /**
   * When the subject entered the state it is in now.
   *
   * What "held too long" is measured from, and deliberately not the subject's
   * `updatedAt`: editing a note does not restart the clock on a device that has
   * been waiting for a part since Tuesday.
   */
  async enteredCurrentStateAt(
    manager: EntityManager,
    subjectId: string,
    tenantId: string,
  ): Promise<Date | undefined> {
    const [last] = await manager.find(this.entity, {
      where: { subjectId, tenantId },
      order: { occurredAt: 'DESC', id: 'DESC' },
      take: 1,
    });
    return last?.occurredAt;
  }

  private async write(
    manager: EntityManager,
    move: Move<Trigger, Actor>,
    from: string | null,
    to: string,
  ): Promise<Recorded> {
    if (!move.actor.trim()) {
      throw new Error('Every transition needs an actor: a name, an id, or the system.');
    }

    const repository = manager.getRepository(this.entity);
    const row = repository.create({
      tenantId: move.tenantId,
      subjectId: move.subjectId,
      fromState: from,
      toState: to,
      trigger: move.trigger,
      actor: move.actor,
      actorType: move.actorType,
      reason: move.reason ?? null,
      reverses: null,
      detail: move.detail ?? null,
    });
    await repository.save(row);

    return { id: row.id, from, to };
  }
}
