import { Column, Entity, Index, Unique } from 'typeorm';
import { BaseEntity, MONEY_AMOUNT_COLUMN } from '@birtalanrobert/database';
import type { PaymentKind, PaymentMethod, PaymentState } from '../payments';

/*
 * The lifecycle types live in the pure entry point and are re-exported here.
 *
 * A console renders a refund button from the same union the entity is typed
 * with, and it must not reach TypeORM to get it.
 */
export type { PaymentKind, PaymentMethod, PaymentState } from '../payments';

/**
 * One movement of money between a customer and a business.
 *
 * **The record outlives the provider.** Amounts, dates, what it was for and who
 * decided are all here in full rather than as identifiers to fetch: a business
 * has to be able to produce its own takings years later, when the provider
 * account may be closed, the API version retired, or the vendor replaced.
 *
 * There is deliberately **no foreign key to the subject**. One product takes a
 * deposit against an appointment, another against a seat, a third against a
 * table's tab — and a key to any one of them is precisely what would stop this
 * table being shared.
 */
@Entity('mortar_payments')
@Unique('uq_payments_tenant_id', ['tenantId', 'id'])
@Index('ix_payments_subject', ['tenantId', 'subject'])
@Index('ix_payments_taken', ['tenantId', 'takenAt'])
@Index('ix_payments_external', ['provider', 'externalId'])
export class Payment extends BaseEntity {
  @Column('uuid')
  tenantId!: string;

  /** What it was for, as the owning product names it: `booking:<id>`. */
  @Column('varchar', { length: 160 })
  subject!: string;

  @Column('varchar', { length: 16 })
  method!: PaymentMethod;

  /**
   * What it was for.
   *
   * A tip belongs to the person who earned it and a product to neither the
   * service nor the diary — a report counting all three as service income tells
   * a business its haircuts are more profitable than they are, and no amount of
   * arithmetic afterwards can separate them again.
   */
  @Column('varchar', { length: 16, default: 'sale' })
  kind!: PaymentKind;

  @Column('varchar', { length: 24, default: 'pending' })
  state!: PaymentState;

  /** Minor units, and the currency it was taken in. Never a float. */
  @Column(MONEY_AMOUNT_COLUMN)
  amount!: string;

  @Column('varchar', { length: 3 })
  currency!: string;

  /**
   * Our cut, taken on top rather than out of the business's money.
   *
   * Recorded even when zero, because "this product charged nothing for that
   * transaction" and "nobody wrote down what it charged" are different facts
   * and only one of them survives an argument.
   */
  @Column({ ...MONEY_AMOUNT_COLUMN, default: '0' })
  applicationFee!: string;

  /** Sum of everything given back. Never more than `amount`. */
  @Column({ ...MONEY_AMOUNT_COLUMN, default: '0' })
  refunded!: string;

  @Column('varchar', { length: 32, nullable: true })
  provider!: string | null;

  /** The provider's identifier, which is what a webhook arrives carrying. */
  @Column('varchar', { length: 128, nullable: true })
  externalId!: string | null;

  /**
   * The last four digits and the brand, for a person to recognise it by.
   *
   * Never the number, never a token that could be charged from a database
   * dump. What a receptionist needs is "Visa ending 4242", and what a customer
   * needs is to know which of their cards was used.
   */
  @Column('varchar', { length: 40, nullable: true })
  instrument!: string | null;

  /** When the money actually moved, which is not when the row was created. */
  @Column('timestamptz', { nullable: true })
  takenAt!: Date | null;

  /** Why it failed, or what a person recorded about a cash payment. */
  @Column('varchar', { length: 400, nullable: true })
  detail!: string | null;

  /** Who recorded it, for the payments a person entered by hand. */
  @Column('uuid', { nullable: true })
  recordedBy!: string | null;
}

/**
 * Money given back, one row per act of giving it.
 *
 * Several partial refunds against one payment is ordinary — a deposit returned
 * in part, a ticket refunded and its fee kept — and a single `refunded` column
 * cannot say when each happened or why. The column stays as the running total,
 * because that is what every read wants, and these rows are what explain it.
 */
@Entity('mortar_payment_refunds')
@Index('ix_payment_refunds_payment', ['tenantId', 'paymentId'])
export class PaymentRefund extends BaseEntity {
  @Column('uuid')
  tenantId!: string;

  @Column('uuid')
  paymentId!: string;

  @Column(MONEY_AMOUNT_COLUMN)
  amount!: string;

  /**
   * Why, in the words of whoever decided.
   *
   * Required rather than optional: "we refunded her ninety lei in March" is a
   * question somebody asks a year later, and a blank reason is an answer
   * nobody can defend.
   */
  @Column('varchar', { length: 400 })
  reason!: string;

  @Column('varchar', { length: 128, nullable: true })
  externalId!: string | null;

  @Column('uuid', { nullable: true })
  refundedBy!: string | null;
}
