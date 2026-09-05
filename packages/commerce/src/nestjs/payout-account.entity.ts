import { Column, Entity, Index, Unique } from 'typeorm';
import { BaseEntity } from '@birtalanrobert/database';
import type { PayoutStatus } from '../deposits';

/**
 * Where a business's money goes, and whether the provider will send it yet.
 *
 * **We never hold anybody's funds.** A customer pays the business directly and
 * our fee is taken on top as an application fee — which is a hard architectural
 * rule rather than a preference, because holding third-party money turns a
 * software company into a regulated payments business.
 *
 * The consequence is this table. Until the provider has verified who the
 * business is, there is nowhere for a payment to land, so every product that
 * takes money on somebody's behalf has to gate its selling on the same fact.
 */
@Entity('mortar_payout_accounts')
@Unique('uq_payout_accounts_tenant', ['tenantId', 'provider'])
@Index('ix_payout_accounts_external', ['provider', 'externalId'])
export class PayoutAccount extends BaseEntity {
  @Column('uuid')
  tenantId!: string;

  /**
   * Which provider this account is with.
   *
   * A column rather than an assumption, because the markets differ: a local
   * processor with faster onboarding beats a lower fee for a restaurant that
   * wants to be live this afternoon, and one of the seventeen will need one.
   */
  @Column('varchar', { length: 32, default: 'stripe' })
  provider!: string;

  /** The provider's own identifier for the account. */
  @Column('varchar', { length: 128 })
  externalId!: string;

  @Column('varchar', { length: 16, default: 'pending' })
  status!: PayoutStatus;

  /**
   * What the provider still wants, in its own words.
   *
   * Kept verbatim rather than translated into a status of ours. "We need a
   * photograph of the director's identity document" is actionable; "restricted"
   * is a support conversation, and the difference is a business that finishes
   * onboarding on a Sunday evening rather than on Tuesday when somebody
   * telephones them.
   */
  @Column('jsonb', { default: () => `'[]'::jsonb` })
  requirements!: string[];

  /** Set the first time the provider said it would pay out. */
  @Column('timestamptz', { nullable: true })
  readyAt!: Date | null;
}
