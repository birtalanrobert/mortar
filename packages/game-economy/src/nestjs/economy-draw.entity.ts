import { Column, Entity, PrimaryColumn } from 'typeorm';

/** What one debit took from one credit. Append-only in the database. */
@Entity({ name: 'mortar_economy_draws' })
export class EconomyDraw {
  /** The debit's entry. */
  @PrimaryColumn({ type: 'uuid' })
  entryId!: string;

  /** The credit's entry. */
  @PrimaryColumn({ type: 'uuid' })
  lotId!: string;

  @Column({ type: 'bigint' })
  amount!: string;
}
