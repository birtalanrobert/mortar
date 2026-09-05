import { Column, Entity, Index, Unique } from 'typeorm';
import { BaseEntity } from '@birtalanrobert/database';

/**
 * A card kept for later, with the words the customer agreed to.
 *
 * **The strongest thing a business can do about people not turning up, short of
 * taking their money.** Nothing leaves the customer's account when they book;
 * the card is simply there if a fee is later decided on — and the decision is
 * still a human one made days afterwards, which is exactly when asking somebody
 * to enter a card is a conversation that does not happen.
 *
 * A hold is not a substitute and must not be sold as one: providers expire an
 * authorisation within days, and an appointment is usually further away.
 *
 * **The consent is stored as text, not as a flag.** A boolean records that
 * somebody clicked; the sentence records what they were told they were agreeing
 * to, which is the only thing worth anything when they say they were not.
 */
@Entity('mortar_saved_cards')
@Unique('uq_saved_cards_tenant_id', ['tenantId', 'id'])
@Index('ix_saved_cards_subject', ['tenantId', 'subject'])
export class SavedCard extends BaseEntity {
  @Column('uuid')
  tenantId!: string;

  /**
   * Whose card it is, as the owning product names it: `customer:<id>`.
   *
   * No foreign key, for the same reason a payment has none — one product hangs
   * a card off a salon's client, another off a tenant's guest.
   */
  @Column('varchar', { length: 160 })
  subject!: string;

  @Column('varchar', { length: 32 })
  provider!: string;

  /** The customer on *our* account, which is where a saved card can be used. */
  @Column('varchar', { length: 128 })
  customerRef!: string;

  @Column('varchar', { length: 128 })
  paymentMethodRef!: string;

  /** Enough to recognise it — "Visa ending 4242" — and nothing more. */
  @Column('varchar', { length: 24, nullable: true })
  brand!: string | null;

  @Column('varchar', { length: 4, nullable: true })
  last4!: string | null;

  @Column('int', { name: 'expiry_month', nullable: true })
  expiryMonth!: number | null;

  @Column('int', { name: 'expiry_year', nullable: true })
  expiryYear!: number | null;

  /** What they were told they were agreeing to, in the language they read it. */
  @Column('varchar', { length: 1000 })
  consentText!: string;

  @Column('timestamptz')
  consentedAt!: Date;

  /** Who stored it, where a member of staff did it on somebody's behalf. */
  @Column('uuid', { nullable: true })
  storedBy!: string | null;
}
