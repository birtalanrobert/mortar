import { Check, Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@birtalanrobert/database';

export type CreditReason = 'purchase' | 'message' | 'adjustment' | 'refund';

/**
 * One movement of a tenant's message credit.
 *
 * **A ledger rather than a counter**, and the difference is the question it can
 * answer: "why has my balance gone down by four hundred" is unanswerable
 * against a number and obvious against a list of entries that each name what
 * they were spent on.
 *
 * The balance is a sum over the entries rather than a column, because a column
 * and a list that disagree is a support conversation nobody can win.
 */
@Entity('message_credits')
@Index('ix_message_credits_tenant', ['tenantId', 'createdAt'])
@Check('ck_message_credits_reason', `"reason" IN ('purchase', 'message', 'adjustment', 'refund')`)
export class MessageCreditEntry extends BaseEntity {
  @Column('uuid')
  tenantId!: string;

  /**
   * Positive for credit bought, negative for messages sent.
   *
   * One column rather than two, so the balance is a sum rather than a
   * subtraction somebody can get the wrong way round. Counted in **segments**,
   * because that is what a provider charges for: one Romanian sentence with its
   * diacritics is two.
   */
  @Column('int')
  segments!: number;

  @Column('varchar', { length: 24 })
  reason!: CreditReason;

  /**
   * What the segments were spent on, as the owning product names it.
   *
   * Deliberately untyped and unconstrained: a repair shop debits against a
   * ticket and a bookkeeper against a document request, and a foreign key to
   * one product's table is the thing that would stop this being shared.
   */
  @Column('uuid', { nullable: true })
  subjectId!: string | null;

  @Column('varchar', { length: 255, nullable: true })
  note!: string | null;
}
