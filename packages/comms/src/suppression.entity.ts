import { Column, Entity, Index, Unique } from 'typeorm';
import { BaseEntity } from '@birtalanrobert/database';

/**
 * Why an address is not written to any more.
 *
 * The two are deliberately separate, because only one of them is the person's
 * decision and they expire differently:
 *
 * - `refused` — the network or the mailbox said no. A dead number, a mailbox
 *   that does not exist. A fact about the *address*, and one that can stop
 *   being true when somebody gets a new telephone.
 * - `unsubscribed` — the person said no. "STOP", or an unsubscribe link. A
 *   fact about the *person*, and it does not expire on its own.
 */
export type SuppressionReason = 'refused' | 'unsubscribed';

/**
 * An address nothing may be sent to.
 *
 * **Checked before every send, not after.** A receipt that says a number
 * refused is a fact nobody acts on: the next reminder goes to the same dead
 * number, is charged for again, and the failure rate that carriers watch keeps
 * climbing until a sender identity is blocked.
 *
 * Tenant-scoped, and that is not obvious. A customer telling one salon to stop
 * has not told the salon down the road anything, and a shared list would let
 * one business silence another's customer — or reveal that the two share one.
 * The cost is that a dead number is discovered once per business, which is the
 * correct trade.
 *
 * Scoped by column rather than by policy — see the migration. The send path has
 * no tenant bound, and a row-level policy there returns no rows rather than
 * refusing, which would disable the suppression silently.
 */
@Entity('mortar_suppressions')
@Unique('uq_suppressions_address', ['tenantId', 'channel', 'address'])
@Index('ix_suppressions_tenant', ['tenantId'])
export class Suppression extends BaseEntity {
  @Column('uuid')
  tenantId!: string;

  @Column('varchar', { length: 8 })
  channel!: 'email' | 'sms' | 'whatsapp';

  /** As the provider was given it: E.164, or the email address. */
  @Column('varchar', { length: 320 })
  address!: string;

  @Column('varchar', { length: 16 })
  reason!: SuppressionReason;

  /**
   * The provider's own words, or the message the person sent.
   *
   * "21610: attempt to send to unsubscribed recipient" is something a business
   * can act on. "Suppressed" is not, and it is what somebody will be told when
   * they ask why a customer stopped hearing from them.
   */
  @Column('varchar', { length: 400, nullable: true })
  detail!: string | null;

  /**
   * How many times the address has refused.
   *
   * A single failure is a telephone switched off; a run of them is a number
   * that has been disconnected. Counting lets the rule be "after three" rather
   * than "after one", which is the difference between suppressing a customer on
   * holiday and suppressing a customer who has moved.
   */
  @Column('integer', { default: 1 })
  failures!: number;

  /**
   * When it may be tried again, or null for never.
   *
   * A refusal expires — people change telephones, and a number suppressed for
   * ever is a customer nobody can reach again through a mistake made once. An
   * unsubscribe does not expire, because it was a decision.
   */
  @Column('timestamptz', { nullable: true })
  expiresAt!: Date | null;
}
