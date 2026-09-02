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
 */
export function appendOnlySql(table: string): string[] {
  const guard = `${table}_immutable`;

  return [
    `CREATE OR REPLACE FUNCTION ${guard}() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION '${table} is append-only; % is not permitted', TG_OP
          USING ERRCODE = 'restrict_violation';
      END;
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
