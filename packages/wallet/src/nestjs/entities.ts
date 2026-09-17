import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * Which device holds which pass.
 *
 * **Deliberately carries no row-level security policy**, and the reason is the
 * same one `platform_operators` has in the products: this table is read *before
 * any tenant is known*. A device identifies itself with an opaque identifier
 * Apple generated and a pass serial — it sends no session, no host and no
 * tenant, because it has none. A policy here would make every lookup return
 * nothing and report success, which is what `FORCE ROW LEVEL SECURITY` does to
 * an unbound read.
 *
 * `tenantId` is recorded all the same, so a product can answer "which devices
 * hold this business's cards" — but that query filters explicitly, and nothing
 * tenant-scoped may join to this table.
 *
 * Nothing here is worth stealing on its own: an APNs token is useless without
 * our signing key, and a serial number is a uuid.
 */
@Entity('mortar_wallet_registration')
@Unique('uq_wallet_registration', ['deviceLibraryIdentifier', 'passTypeIdentifier', 'serialNumber'])
@Index('ix_wallet_registration_pass', ['passTypeIdentifier', 'serialNumber'])
@Index('ix_wallet_registration_device', ['deviceLibraryIdentifier', 'passTypeIdentifier'])
export class WalletRegistration {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  /** Apple's opaque per-device identifier. The device's only credential. */
  @Column('varchar', { name: 'device_library_identifier', length: 128 })
  deviceLibraryIdentifier!: string;

  /** Where the silent push goes. Changes when the device reinstalls. */
  @Column('varchar', { name: 'push_token', length: 200 })
  pushToken!: string;

  @Column('varchar', { name: 'pass_type_identifier', length: 128 })
  passTypeIdentifier!: string;

  @Column('varchar', { name: 'serial_number', length: 128 })
  serialNumber!: string;

  /** For reporting only. Never a join, and never a policy — see above. */
  @Column('uuid', { name: 'tenant_id', nullable: true })
  tenantId!: string | null;
}

/**
 * What happened to each push.
 *
 * The substitute for watching a phone. There is no device in this programme, so
 * the only evidence that an update reached anybody is what Apple and Google say
 * when we ask them to deliver it — and that evidence is worth nothing unless it
 * is written down. `410 Unregistered` in particular is the only signal there is
 * that a holder deleted their card without the deregistration arriving.
 */
@Entity('mortar_wallet_push_delivery')
@Index('ix_wallet_push_pass', ['passTypeIdentifier', 'serialNumber'])
@Index('ix_wallet_push_created', ['createdAt'])
export class WalletPushDelivery {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @Column('varchar', { name: 'pass_type_identifier', length: 128 })
  passTypeIdentifier!: string;

  @Column('varchar', { name: 'serial_number', length: 128 })
  serialNumber!: string;

  @Column('varchar', { name: 'device_library_identifier', length: 128, nullable: true })
  deviceLibraryIdentifier!: string | null;

  /** `apple` or `google`. Both are recorded here so one screen answers for both. */
  @Column('varchar', { length: 16 })
  platform!: string;

  /** 200 accepted, 410 the device no longer holds it, 0 the transport failed. */
  @Column('int')
  status!: number;

  /** The provider's own word: `Unregistered`, `BadDeviceToken`, `TopicDisallowed`. */
  @Column('varchar', { length: 200, nullable: true })
  reason!: string | null;

  /** The provider's identifier for the push, for their support to look up. */
  @Column('varchar', { name: 'provider_id', length: 200, nullable: true })
  providerId!: string | null;

  @Column('uuid', { name: 'tenant_id', nullable: true })
  tenantId!: string | null;
}

/**
 * What a device said went wrong, in its own words.
 *
 * `POST /v1/log` is the only diagnostic channel Apple provides, and it is worth
 * more here than in a project with a phone to look at: a signature a device
 * refuses, a web service it cannot reach and a pass it will not install all
 * arrive here and nowhere else.
 */
@Entity('mortar_wallet_device_log')
@Index('ix_wallet_device_log_created', ['createdAt'])
export class WalletDeviceLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @Column('text')
  message!: string;
}
