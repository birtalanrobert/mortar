import { Column, Entity, Index, Unique } from 'typeorm';
import { BaseEntity } from '@birtalanrobert/database';
import type { OverageBehaviour } from '../usage';
import type { SubscriptionStatus } from '../subscriptions';

/**
 * What one business pays us, and what that entitles it to.
 *
 * **The plan is stored by code, not by foreign key.** A business that bought
 * "Salon, five staff included" keeps those terms; a key into a table somebody
 * edits in April rewrites what they agreed to in March. The code resolves to
 * whichever row currently describes it, and a price change is a new plan row
 * rather than an edit.
 *
 * One row per tenant. A business with two subscriptions is a business with an
 * argument about which one applies.
 */
@Entity('mortar_subscriptions')
@Unique('uq_subscriptions_tenant', ['tenantId'])
@Index('ix_subscriptions_external', ['externalId'])
export class Subscription extends BaseEntity {
  @Column('uuid')
  tenantId!: string;

  @Column('varchar', { length: 64 })
  planCode!: string;

  @Column('varchar', { length: 16, default: 'none' })
  status!: SubscriptionStatus;

  /** Seats, staff, units — whatever this plan counts. */
  @Column('integer', { default: 0 })
  quantity!: number;

  /** The customer on our own account, which is where the card lives. */
  @Column('varchar', { length: 128, nullable: true })
  customerRef!: string | null;

  @Column('varchar', { length: 128, nullable: true })
  externalId!: string | null;

  @Column('timestamptz', { nullable: true })
  trialEndsAt!: Date | null;

  @Column('timestamptz', { nullable: true })
  currentPeriodEnd!: Date | null;

  /**
   * When the last invoice went unpaid.
   *
   * Dunning is measured from here rather than counted in attempts, because a
   * customer experiences days and not retries. Cleared the moment one is paid.
   */
  @Column('timestamptz', { nullable: true })
  pastDueSince!: Date | null;

  /** Set once they have asked to stop at the end of what they paid for. */
  @Column('timestamptz', { nullable: true })
  cancelAt!: Date | null;

  /**
   * What happens when a metered allowance runs out.
   *
   * The tenant's choice. A business that would rather stop than be charged is
   * making a reasonable decision about its own margin.
   */
  @Column('varchar', { length: 8, default: 'block' })
  overage!: OverageBehaviour;
}
