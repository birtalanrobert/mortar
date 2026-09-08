import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@birtalanrobert/database';

/**
 * One browser that has agreed to be written to.
 *
 * The endpoint is the address and the two keys encrypt to it. All three come
 * from the browser's own `PushSubscription` object; none is a secret we chose,
 * which is why they are stored rather than derived and why a device that
 * reinstalls arrives as a new row rather than as an update to an old one.
 *
 * `subject` names the relationship rather than one product's noun — an employee
 * in a rota, a customer in a loyalty scheme, a rep in a wholesale portal. A
 * foreign key to any of those is exactly what would stop this being shared.
 */
@Entity('mortar_push_subscription')
export class PushSubscription extends BaseEntity {
  /** Null where the product has no tenancy, which some do not. */
  @Column('uuid', { nullable: true })
  tenantId!: string | null;

  @Index()
  @Column('varchar', { length: 200 })
  subject!: string;

  /** A URL, and long: some push services mint endpoints past 500 bytes. */
  @Column('varchar', { length: 1000 })
  endpoint!: string;

  @Column('varchar', { length: 255 })
  p256dh!: string;

  @Column('varchar', { length: 255 })
  auth!: string;

  /**
   * What the browser called itself.
   *
   * So a person revoking one device can tell which is which. Optional, because
   * a browser that reports nothing useful should not stop somebody subscribing.
   */
  @Column('varchar', { length: 200, nullable: true })
  label!: string | null;

  /**
   * When something was last delivered here.
   *
   * A subscription that has not been used in a year is one whose owner has
   * changed phone twice — kept rather than swept, because the push service is
   * the authority on that and answers 410 when it is right.
   */
  @Column('timestamptz', { nullable: true })
  lastUsedAt!: Date | null;
}
