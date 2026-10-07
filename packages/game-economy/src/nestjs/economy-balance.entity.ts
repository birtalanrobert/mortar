import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * A holder's balance in one currency: a cache of the ledger, written with
 * every entry, and the row each write locks — so a holder's writes take turns
 * and a balance can never go below zero.
 */
@Entity({ name: 'mortar_economy_balances' })
export class EconomyBalance {
  @PrimaryColumn({ type: 'varchar', length: 128 })
  holderId!: string;

  @PrimaryColumn({ type: 'varchar', length: 32 })
  currency!: string;

  @Column({ type: 'bigint' })
  balance!: string;

  @Column({ type: 'timestamptz' })
  updatedAt!: Date;
}
