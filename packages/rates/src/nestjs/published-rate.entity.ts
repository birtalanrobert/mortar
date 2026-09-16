import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * One publisher's rate for one pair on one day.
 *
 * No tenant column and no `BaseEntity`: this is reference data shared by every
 * customer of whatever product registers it. The BNR's rate for the 15th of
 * September is the same fact for all of them, and giving it a tenant column
 * would mean storing it once per account.
 *
 * **Which service owns the migration is the consuming product's decision**, and
 * it matters: whichever service *reads* rates should apply it, because a table
 * whose creation waited on the fetching worker being deployed would be a
 * product's figures waiting on it too. A missing write retries; a missing read
 * does not.
 */
@Entity('mortar_published_rates')
@Unique('uq_mortar_published_rates_day', ['source', 'base', 'quote', 'asOf'])
@Index('ix_mortar_published_rates_lookup', ['base', 'quote', 'source', 'asOf'])
export class PublishedRate {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column('varchar', { length: 16 })
  source!: string;

  @Column('char', { length: 3 })
  base!: string;

  @Column('char', { length: 3 })
  quote!: string;

  /**
   * A string, not a `Date`.
   *
   * The column is `date` and TypeORM hands those back as `YYYY-MM-DD`, which is
   * exactly what `ExchangeRate.asOf` wants — and a `Date` would carry a
   * timezone nobody meant, so the same rate would be Monday's or Tuesday's
   * depending on where the process runs.
   */
  @Column('date')
  asOf!: string;

  /** A decimal string, for the same reason: it never becomes a float. */
  @Column('numeric', { precision: 20, scale: 10 })
  rate!: string;
}
