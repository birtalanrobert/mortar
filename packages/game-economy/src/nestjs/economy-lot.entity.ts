import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { CreditKind } from '../kinds';

/** A credit as debits draw on it: how much of it is left — a cache of its draws. */
@Entity({ name: 'mortar_economy_lots' })
export class EconomyLot {
  /** The credit's entry. */
  @PrimaryColumn({ type: 'uuid' })
  entryId!: string;

  @Column({ type: 'varchar', length: 128 })
  holderId!: string;

  @Column({ type: 'varchar', length: 32 })
  currency!: string;

  @Column({ type: 'varchar', length: 16 })
  kind!: CreditKind;

  @Column({ type: 'bigint' })
  amount!: string;

  @Column({ type: 'bigint' })
  remaining!: string;

  /** The credit's place in the ledger's order. */
  @Column({ type: 'bigint' })
  seq!: string;
}
