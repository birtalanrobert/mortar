import { Column, Entity, Index, Unique } from 'typeorm';
import { BaseEntity } from '@birtalanrobert/database';

/**
 * What a tenant used, on a day, of one thing worth charging for.
 *
 * **Ours, not the provider's.** The provider's meter is what produces an
 * invoice; this is what produces an answer to "why is my bill 340 lei this
 * month", asked eight months later by somebody who has every right to know and
 * whose provider records may by then be aggregated away.
 *
 * A row per tenant, meter and day, so that reporting the same day twice — a
 * retried job, a redeploy mid-run — updates rather than doubles.
 */
@Entity('mortar_usage_records')
@Unique('uq_usage_records_day', ['tenantId', 'meter', 'day'])
@Index('ix_usage_records_reported', ['reportedAt'])
export class UsageRecord extends BaseEntity {
  @Column('uuid')
  tenantId!: string;

  /** What is counted, as the product names it: `sms_segment`, `ticket`. */
  @Column('varchar', { length: 64 })
  meter!: string;

  /** The tenant's own day, decided by the product rather than by UTC. */
  @Column('date')
  day!: string;

  @Column('integer', { default: 0 })
  quantity!: number;

  /**
   * When the provider was told, or null if it has not been.
   *
   * The gap between counting and reporting is where a nightly job's failure
   * lives, and a column that says which rows are still owed is the difference
   * between noticing and not.
   */
  @Column('timestamptz', { nullable: true })
  reportedAt!: Date | null;
}
