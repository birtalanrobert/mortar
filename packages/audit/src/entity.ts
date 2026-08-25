import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * One recorded action.
 *
 * Append-only by contract: this package exposes no update or delete for
 * individual rows, and the migration revokes both at the database level for
 * the application role. An audit trail that can be edited is not an audit
 * trail, and the projects in this catalogue use it to settle disputes about
 * money, hours worked and who saw whose data.
 */
@Entity({ name: 'mortar_audit_log' })
@Index('idx_audit_tenant_occurred', ['tenantId', 'occurredAt'])
@Index('idx_audit_entity', ['tenantId', 'entityType', 'entityId', 'occurredAt'])
@Index('idx_audit_actor', ['tenantId', 'actorId', 'occurredAt'])
@Index('idx_audit_correlation', ['correlationId'])
export class AuditLogEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Null for platform-level actions that belong to no tenant. */
  @Column({ type: 'uuid', nullable: true })
  tenantId!: string | null;

  /** Dotted, past-tense, e.g. `booking.cancelled`, `invoice.issued`. */
  @Column({ type: 'varchar', length: 128 })
  action!: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  entityType!: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  entityId!: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  actorId!: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  actorType!: string | null;

  /**
   * The actor's name as it was at the time.
   *
   * Denormalised deliberately: a user who is later deleted or renamed must
   * still be identifiable in the trail, and a join to a mutable table would
   * quietly rewrite history.
   */
  @Column({ type: 'varchar', length: 256, nullable: true })
  actorName!: string | null;

  /** Set when an operator acted through impersonation. Both are recorded. */
  @Column({ type: 'varchar', length: 128, nullable: true })
  impersonatedBy!: string | null;

  /** Only the fields that changed, as `{ field: { from, to } }`. */
  @Column({ type: 'jsonb', nullable: true })
  changes!: Record<string, { from: unknown; to: unknown }> | null;

  /** Action-specific context: a reason, an amount, a source channel. */
  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  requestId!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  correlationId!: string | null;

  @Column({ type: 'inet', nullable: true })
  ip!: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  userAgent!: string | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  occurredAt!: Date;
}
