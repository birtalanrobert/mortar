import { Column, CreateDateColumn, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Every state change, append-only — as a base class rather than a table.
 *
 * The shape is shared; the table is not. Each product owns its own
 * (`request_transitions`, `ticket_transitions`) so it can foreign-key to its
 * subject, cascade on delete, and carry its own row-level security policy —
 * none of which is possible in one table shared across products, and all of
 * which is the difference between a log that is maintained and one that
 * accumulates orphans.
 *
 * ```ts
 * @Entity('ticket_transitions')
 * @Index('ix_ticket_transitions_subject', ['subjectId', 'occurredAt'])
 * export class TicketTransition extends TransitionLogEntity {}
 * ```
 */
export abstract class TransitionLogEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  @Index()
  tenantId!: string;

  /** The ticket, request or order this happened to. */
  @Column({ type: 'uuid' })
  subjectId!: string;

  /** Null for the move that created the subject — there was nothing before it. */
  @Column({ type: 'varchar', length: 48, nullable: true })
  fromState!: string | null;

  @Column({ type: 'varchar', length: 48 })
  toState!: string;

  @Column({ type: 'varchar', length: 48 })
  trigger!: string;

  /**
   * Free string, not a foreign key.
   *
   * The actor is frequently the system, and frequently somebody with no account
   * by design — a customer following a signed link. A foreign key here would
   * force an account to exist for the sake of the log, which is the tail
   * wagging the product.
   */
  @Column({ type: 'varchar', length: 160 })
  actor!: string;

  /** Which kind of actor, in this lifecycle's own vocabulary. */
  @Column({ type: 'varchar', length: 32 })
  actorType!: string;

  /**
   * Why, in the person's own words.
   *
   * Optional for an ordinary move and **required for a reversal**, enforced by
   * the service rather than by the column: a reversal with no reason is an
   * unexplained rewriting of history, which is exactly what a log exists to
   * prevent.
   */
  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  /**
   * Set on a reversal, naming the transition it undoes.
   *
   * A reversal is recorded as a new row rather than by deleting the mistaken
   * one. The mistake is part of what happened, and a log that can be tidied is
   * not evidence of anything.
   */
  @Column({ type: 'uuid', nullable: true })
  reverses!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  detail!: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'timestamptz' })
  occurredAt!: Date;
}

/** What an append-only table may still permit. */
export interface AppendOnlyOptions {
  /**
   * Columns a retention sweep may set to `NULL`, and nothing else.
   *
   * Append-only and a retention schedule pull against each other: the row is
   * evidence and must not be rewritten, while one *column* of it — a location
   * trace, a photograph, an IP address — is personal data with a published
   * expiry date. Without this the only way to keep the promise is to drop the
   * trigger, sweep, and put it back, which is an operation performed under
   * time pressure on production and sometimes forgotten halfway.
   *
   * So the erasure is narrowed rather than the protection removed. An update is
   * permitted only when every named column ends up `NULL` and every other
   * column is byte-for-byte what it was. Nulling an already-null column is
   * allowed, so a sweep that runs twice is not an error.
   */
  readonly redactable?: readonly string[];
}

/**
 * Makes a transition table refuse updates.
 *
 * The same shape `enableRlsSql` has, and for the same reason: the SQL belongs
 * beside the thing it protects, and a product writing it by hand writes it
 * slightly differently each time. A trigger rather than a revoked privilege,
 * because the application role owns the table and an owner cannot be denied by
 * a grant.
 *
 * **Updates only. Deletes are deliberately allowed**, and the reason is
 * erasure: a transition table carries `subject_id` and almost always a foreign
 * key with `ON DELETE CASCADE`, so blocking deletes would mean a customer's
 * right to erasure could not be honoured without first dropping this trigger —
 * an operation somebody performs under pressure, on production, and sometimes
 * forgets to put back.
 *
 * The property that matters is that history cannot be *rewritten*. Removing a
 * subject and everything about it is a different operation, it is one the law
 * requires to work, and it leaves no misleading record behind — which a
 * silently edited actor or reason does.
 *
 * `redactable` is the same argument applied to one column rather than one row;
 * see {@link AppendOnlyOptions}.
 */
export function appendOnlySql(table: string, options: AppendOnlyOptions = {}): string[] {
  const guard = `${table}_immutable`;
  const redactable = options.redactable ?? [];

  /*
   * Checked here rather than left to Postgres, because the failure is otherwise
   * both late and misleading: a misspelled column makes `to_jsonb(NEW) -> …`
   * answer SQL NULL, the guard refuses every update including the redaction it
   * was added for, and the message names append-only rather than the typo.
   */
  for (const column of redactable) {
    if (!/^[a-z_][a-z0-9_]*$/i.test(column)) {
      throw new Error(
        `Not a column name: '${column}'. Redactable columns are unquoted identifiers.`,
      );
    }
  }

  const refuse = `RAISE EXCEPTION '${table} is append-only; % is not permitted', TG_OP
          USING ERRCODE = 'restrict_violation';`;

  /*
   * Two shapes rather than one general one, so a table with nothing redactable
   * keeps exactly the function it had. The general form permits an update that
   * changes nothing at all — harmless, but a difference, and a table protecting
   * evidence is the wrong place to introduce one nobody asked for.
   */
  const body =
    redactable.length === 0
      ? `BEGIN
        ${refuse}
      END;`
      : `DECLARE
        redactable constant text[] := ARRAY[${redactable.map((column) => `'${column}'`).join(', ')}];
        erased text;
      BEGIN
        -- Everything outside the redactable set first, and the order is the
        -- message rather than the outcome: checked the other way round, an
        -- ordinary rewrite of some unrelated column is still refused but is
        -- refused for leaving the *location* untouched, which sends whoever
        -- reads the log looking at the wrong column. jsonb equality ignores key
        -- order, and both sides are converted the same way, so this compares
        -- values rather than two renderings.
        IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - redactable) = (to_jsonb(OLD) - redactable) THEN
          FOREACH erased IN ARRAY redactable LOOP
            IF (to_jsonb(NEW) -> erased) IS DISTINCT FROM 'null'::jsonb THEN
              RAISE EXCEPTION '${table}.% may be erased but not written', erased
                USING ERRCODE = 'restrict_violation';
            END IF;
          END LOOP;

          RETURN NEW;
        END IF;

        ${refuse}
      END;`;

  return [
    `CREATE OR REPLACE FUNCTION ${guard}() RETURNS trigger AS $$
      ${body}
      $$ LANGUAGE plpgsql`,
    `CREATE TRIGGER ${table}_no_rewrite
       BEFORE UPDATE ON "${table}"
       FOR EACH ROW EXECUTE FUNCTION ${guard}()`,
  ];
}

export function dropAppendOnlySql(table: string): string[] {
  return [
    `DROP TRIGGER IF EXISTS ${table}_no_rewrite ON "${table}"`,
    `DROP FUNCTION IF EXISTS ${table}_immutable()`,
  ];
}
