import { Column, Entity, Index, Unique } from 'typeorm';
import { BaseEntity, MONEY_AMOUNT_COLUMN } from '@birtalanrobert/database';
import type { TenantOwned } from '@birtalanrobert/tenancy';
import type { Denomination, EntryKind } from '../ledger';

/**
 * A gift voucher, a prepaid package, or a balance.
 *
 * The row carries what the instrument *is*; what has happened to it is in
 * `mortar_voucher_entries`. `balance` is a cache of that ledger's sum, written
 * in the same transaction as the entry that changed it, and constrained so it
 * can never go below zero — the check is the guarantee, the ledger is the
 * explanation.
 */
@Entity('mortar_vouchers')
@Unique('uq_vouchers_tenant_id', ['tenantId', 'id'])
@Unique('uq_vouchers_code', ['tenantId', 'code'])
@Index('ix_vouchers_holder', ['tenantId', 'holderId'])
export class VoucherEntity extends BaseEntity implements TenantOwned {
  @Column('uuid')
  tenantId!: string;

  /** What is printed on the card, normalised before it is stored. */
  @Column('varchar', { length: 32 })
  code!: string;

  @Column('varchar', { length: 8 })
  denomination!: Denomination;

  /** Set for money, null for units — a session has no currency. */
  @Column('varchar', { length: 3, nullable: true })
  currency!: string | null;

  /**
   * What a package is for, in the consuming product's own words.
   *
   * Null for a gift voucher, which is money and spends against anything.
   * Deliberately a string rather than a foreign key: this table is shared, and
   * a key to one product's services is exactly what would stop it being.
   */
  @Column('varchar', { length: 160, nullable: true })
  subject!: string | null;

  @Column(MONEY_AMOUNT_COLUMN)
  issuedAmount!: string;

  @Column(MONEY_AMOUNT_COLUMN)
  balance!: string;

  /** Null means it does not expire, which is the default and the safe answer. */
  @Column('timestamptz', { nullable: true })
  expiresAt!: Date | null;

  @Column('timestamptz', { nullable: true })
  cancelledAt!: Date | null;

  @Column('varchar', { length: 240, nullable: true })
  cancelledReason!: string | null;

  /** Who it is for, and who bought it — often two different people. */
  @Column('uuid', { nullable: true })
  holderId!: string | null;

  @Column('varchar', { length: 160, nullable: true })
  holderName!: string | null;

  @Column('varchar', { length: 160, nullable: true })
  boughtByName!: string | null;

  @Column('text', { nullable: true })
  note!: string | null;
}

/**
 * One thing that happened to a voucher.
 *
 * Append-only, enforced by a trigger. A correction is a new row, which is what
 * makes the history readable rather than merely current.
 */
@Entity('mortar_voucher_entries')
@Unique('uq_voucher_entries_tenant_id', ['tenantId', 'id'])
@Index('ix_voucher_entries_voucher', ['tenantId', 'voucherId', 'createdAt'])
export class VoucherEntryEntity extends BaseEntity implements TenantOwned {
  @Column('uuid')
  tenantId!: string;

  @Column('uuid')
  voucherId!: string;

  @Column('varchar', { length: 16 })
  kind!: EntryKind;

  /** Always positive. The direction belongs to the kind. */
  @Column(MONEY_AMOUNT_COLUMN)
  amount!: string;

  /** What it was spent against: `booking:<id>`, `order:<id>`. */
  @Column('varchar', { length: 160, nullable: true })
  subject!: string | null;

  @Column('varchar', { length: 400, nullable: true })
  note!: string | null;

  @Column('uuid', { nullable: true })
  actorId!: string | null;
}
