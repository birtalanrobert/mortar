import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDataSource } from '@birtalanrobert/database';
import { Entity, Index, type DataSource } from 'typeorm';
import { defineMachine } from './machine';
import { TransitionLog, TransitionRefused } from './log';
import { TransitionLogEntity, appendOnlySql } from './log.entity';

type State = 'received' | 'diagnosed' | 'repaired' | 'collected' | 'returned';
type Trigger = 'diagnose' | 'repair' | 'collect' | 'give_back';
type Actor = 'staff' | 'customer' | 'system';

/**
 * A product's own table, which is the point of the base class.
 *
 * Declared here rather than reusing one from a package, because what is being
 * tested is that a product can bring its own table name and index and have the
 * service work against it.
 */
@Entity('test_ticket_transitions')
@Index('ix_test_ticket_transitions_subject', ['subjectId', 'occurredAt'])
class TicketTransition extends TransitionLogEntity {}

const MACHINE = defineMachine<State, Trigger, Actor>({
  states: ['received', 'diagnosed', 'repaired', 'collected', 'returned'],
  initial: 'received',
  terminal: ['collected', 'returned'],
  transitions: [
    { from: 'received', to: 'diagnosed', trigger: 'diagnose', by: ['staff'] },
    { from: 'diagnosed', to: 'repaired', trigger: 'repair', by: ['staff'] },
    { from: 'diagnosed', to: 'returned', trigger: 'give_back', by: ['staff'] },
    { from: 'repaired', to: 'collected', trigger: 'collect', by: ['staff', 'customer'] },
  ],
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const TICKET = '22222222-2222-4222-8222-222222222222';

let dataSource: DataSource;
let log: TransitionLog<State, Trigger, Actor>;

beforeEach(async () => {
  dataSource ??= await createTestDataSource([TicketTransition], {
    migrations: [
      class CreateTestTicketTransitions1788000000000 {
        name = 'CreateTestTicketTransitions1788000000000';
        async up(runner: { query: (sql: string) => Promise<unknown> }) {
          await runner.query(`
            CREATE TABLE "test_ticket_transitions" (
              "id" uuid NOT NULL DEFAULT gen_random_uuid(),
              "tenant_id" uuid NOT NULL,
              "subject_id" uuid NOT NULL,
              "from_state" varchar(48),
              "to_state" varchar(48) NOT NULL,
              "trigger" varchar(48) NOT NULL,
              "actor" varchar(160) NOT NULL,
              "actor_type" varchar(32) NOT NULL,
              "reason" text,
              "reverses" uuid,
              "detail" jsonb,
              "occurred_at" timestamptz NOT NULL DEFAULT now(),
              CONSTRAINT "pk_test_ticket_transitions" PRIMARY KEY ("id")
            )
          `);
          // The real trigger, from the package. `synchronize` would create the
          // columns and silently skip this.
          for (const statement of appendOnlySql('test_ticket_transitions')) {
            await runner.query(statement);
          }
        }
        async down() {}
      },
    ],
  });

  await dataSource.query(`DELETE FROM "test_ticket_transitions"`);
  log = new TransitionLog<State, Trigger, Actor>(MACHINE, TicketTransition);
});

afterAll(async () => {
  if (dataSource?.isInitialized) await dataSource.destroy();
});

const open = () =>
  log.record(dataSource.manager, {
    subjectId: TICKET,
    tenantId: TENANT,
    from: null,
    trigger: 'diagnose',
    actor: 'ana',
    actorType: 'staff',
  });

describe('the transition log', () => {
  it('opens on the lifecycle’s initial state, whatever it is asked for', async () => {
    // A subject created directly into the middle of its lifecycle has skipped
    // everything that should have happened first, and no later query can tell.
    const opened = await open();

    expect(opened.from).toBeNull();
    expect(opened.to).toBe('received');
  });

  it('records a legal move and answers with where it lands', async () => {
    await open();
    const moved = await log.record(dataSource.manager, {
      subjectId: TICKET,
      tenantId: TENANT,
      from: 'received',
      trigger: 'diagnose',
      actor: 'ana',
      actorType: 'staff',
      detail: { fault: 'screen' },
    });

    expect(moved).toMatchObject({ from: 'received', to: 'diagnosed' });
  });

  it('refuses a move the actor may not make, and says what they may', async () => {
    await open();

    await expect(
      log.record(dataSource.manager, {
        subjectId: TICKET,
        tenantId: TENANT,
        from: 'received',
        trigger: 'diagnose',
        actor: 'the customer',
        actorType: 'customer',
      }),
    ).rejects.toThrow(TransitionRefused);
  });

  it('writes nothing when it refuses', async () => {
    // The check and the write are the same call precisely so that this holds.
    // A refusal that still left a row would make the log evidence of a move
    // that never happened.
    await open();
    await expect(
      log.record(dataSource.manager, {
        subjectId: TICKET,
        tenantId: TENANT,
        from: 'received',
        trigger: 'collect',
        actor: 'ana',
        actorType: 'staff',
      }),
    ).rejects.toThrow();

    expect(await log.history(dataSource.manager, TICKET, TENANT)).toHaveLength(1);
  });

  it('rolls back with the caller, because it never opens its own transaction', async () => {
    /*
     * The reason every method takes an `EntityManager`.
     *
     * A subject whose state advanced without a log entry has a hole in its
     * history; a log entry for a move that rolled back is worse, because it
     * vouches for something that did not happen.
     */
    await open();

    await expect(
      dataSource.transaction(async (manager) => {
        await log.record(manager, {
          subjectId: TICKET,
          tenantId: TENANT,
          from: 'received',
          trigger: 'diagnose',
          actor: 'ana',
          actorType: 'staff',
        });
        throw new Error('the caller failed after the move');
      }),
    ).rejects.toThrow('the caller failed after the move');

    expect(await log.history(dataSource.manager, TICKET, TENANT)).toHaveLength(1);
  });

  it('cannot be rewritten', async () => {
    const opened = await open();

    await expect(
      dataSource.query(
        `UPDATE "test_ticket_transitions" SET "actor" = 'somebody else' WHERE id = $1`,
        [opened.id],
      ),
    ).rejects.toThrow(/append-only/);

    /*
     * A delete is allowed, and that is deliberate.
     *
     * This table carries a foreign key to its subject with `ON DELETE CASCADE`
     * in every real product, so blocking deletes would mean a customer's right
     * to erasure could not be honoured without dropping the trigger first —
     * done under pressure, on production, and sometimes not put back.
     *
     * What must not happen is history being *rewritten*, which is the assertion
     * above. Removing a subject and everything about it leaves no misleading
     * record behind; a silently edited actor does.
     */
    await expect(
      dataSource.query(`DELETE FROM "test_ticket_transitions" WHERE id = $1`, [opened.id]),
    ).resolves.toBeDefined();
  });

  it('reads a history oldest first', async () => {
    await open();
    await log.record(dataSource.manager, {
      subjectId: TICKET,
      tenantId: TENANT,
      from: 'received',
      trigger: 'diagnose',
      actor: 'ana',
      actorType: 'staff',
    });
    await log.record(dataSource.manager, {
      subjectId: TICKET,
      tenantId: TENANT,
      from: 'diagnosed',
      trigger: 'repair',
      actor: 'ana',
      actorType: 'staff',
    });

    expect(
      (await log.history(dataSource.manager, TICKET, TENANT)).map((row) => row.toState),
    ).toEqual(['received', 'diagnosed', 'repaired']);
  });

  it('shows one subject nothing of another’s', async () => {
    await open();
    const other = '33333333-3333-4333-8333-333333333333';

    expect(await log.history(dataSource.manager, other, TENANT)).toEqual([]);
  });

  it('refuses a move with no actor', async () => {
    await expect(
      log.record(dataSource.manager, {
        subjectId: TICKET,
        tenantId: TENANT,
        from: null,
        trigger: 'diagnose',
        actor: '   ',
        actorType: 'staff',
      }),
    ).rejects.toThrow(/needs an actor/);
  });
});

describe('reversing a move', () => {
  const reach = async (...moves: Array<[State, Trigger]>) => {
    await open();
    for (const [from, trigger] of moves) {
      await log.record(dataSource.manager, {
        subjectId: TICKET,
        tenantId: TENANT,
        from,
        trigger,
        actor: 'ana',
        actorType: 'staff',
      });
    }
  };

  it('is the only way out of a terminal state', async () => {
    await reach(['received', 'diagnose'], ['diagnosed', 'repair'], ['repaired', 'collect']);

    // Nothing may transition out of `collected` — the machine refuses to be
    // defined that way. A device handed to the wrong person still has to be
    // put right, and this is how.
    expect(MACHINE.available('collected', 'staff')).toEqual([]);

    const reversed = await log.reverse(dataSource.manager, {
      subjectId: TICKET,
      tenantId: TENANT,
      actor: 'the owner',
      actorType: 'staff',
      reason: 'handed to the wrong customer',
    });

    expect(reversed).toMatchObject({ from: 'collected', to: 'repaired' });
  });

  it('records the reversal rather than deleting the mistake', async () => {
    await reach(['received', 'diagnose']);
    await log.reverse(dataSource.manager, {
      subjectId: TICKET,
      tenantId: TENANT,
      actor: 'the owner',
      actorType: 'staff',
      reason: 'diagnosed the wrong device',
    });

    const history = await log.history(dataSource.manager, TICKET, TENANT);

    // Three rows: the mistake is still there. A log that can be tidied is not
    // evidence of anything.
    expect(history).toHaveLength(3);
    expect(history[2]).toMatchObject({
      trigger: 'reverse',
      fromState: 'diagnosed',
      toState: 'received',
      reason: 'diagnosed the wrong device',
    });
    expect(history[2]?.reverses).toBe(history[1]?.id);
  });

  it('refuses a reversal with no reason', async () => {
    await reach(['received', 'diagnose']);

    await expect(
      log.reverse(dataSource.manager, {
        subjectId: TICKET,
        tenantId: TENANT,
        actor: 'the owner',
        actorType: 'staff',
        reason: '  ',
      }),
    ).rejects.toThrow(TransitionRefused);
  });

  it('refuses to reverse a reversal', async () => {
    // Oscillation means nothing. Going forward again is an ordinary move and
    // should read as one in the history.
    await reach(['received', 'diagnose']);
    await log.reverse(dataSource.manager, {
      subjectId: TICKET,
      tenantId: TENANT,
      actor: 'the owner',
      actorType: 'staff',
      reason: 'wrong device',
    });

    await expect(
      log.reverse(dataSource.manager, {
        subjectId: TICKET,
        tenantId: TENANT,
        actor: 'the owner',
        actorType: 'staff',
        reason: 'again',
      }),
    ).rejects.toThrow(/itself a reversal/);
  });

  it('refuses to reverse the opening move', async () => {
    await open();

    await expect(
      log.reverse(dataSource.manager, {
        subjectId: TICKET,
        tenantId: TENANT,
        actor: 'the owner',
        actorType: 'staff',
        reason: 'created by mistake',
      }),
    ).rejects.toThrow(/no state to return to/);
  });

  it('refuses to reverse what never happened', async () => {
    await expect(
      log.reverse(dataSource.manager, {
        subjectId: TICKET,
        tenantId: TENANT,
        actor: 'the owner',
        actorType: 'staff',
        reason: 'nothing here',
      }),
    ).rejects.toThrow(/Nothing has happened/);
  });

  it('tells you when the current state was entered', async () => {
    // What "held too long" measures from — deliberately not the subject's
    // `updatedAt`, because editing a note must not restart the clock on a
    // device that has been waiting for a part since Tuesday.
    await reach(['received', 'diagnose']);

    const entered = await log.enteredCurrentStateAt(dataSource.manager, TICKET, TENANT);

    expect(entered).toBeInstanceOf(Date);
  });
});
