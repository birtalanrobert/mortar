import { getContext } from '@mortar/context';
import { resolveManager } from '@mortar/database';
import type { DataSource, EntityManager } from 'typeorm';
import { AuditLogEntry } from './entity';
import { computeChanges, redactMetadata, type Changes, type DiffOptions } from './diff';

export interface RecordOptions extends DiffOptions {
  /** Dotted, past-tense: `booking.cancelled`, `invoice.issued`. */
  action: string;
  entityType?: string;
  entityId?: string;
  /** The record before the change. */
  before?: Record<string, unknown> | null;
  /** The record after the change. */
  after?: Record<string, unknown> | null;
  /** Pre-computed changes, when the caller already knows them. */
  changes?: Changes | null;
  metadata?: Record<string, unknown>;
  /**
   * Overrides the tenant from the ambient context.
   *
   * Needed for platform-level actions, and for the rare case of acting on one
   * tenant from another's context (an operator tool, a migration).
   */
  tenantId?: string | null;
  /** Overrides the actor from the ambient context. */
  actor?: { id: string; type: string; name?: string; impersonatedBy?: string };
  occurredAt?: Date;
}

export interface AuditQuery {
  tenantId?: string;
  entityType?: string;
  entityId?: string;
  actorId?: string;
  action?: string;
  correlationId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

/**
 * Writes and reads the audit trail.
 *
 * The single most important property: `record()` writes through the **active
 * transaction** when there is one. An audit row for a change that then rolled
 * back is worse than no audit row at all, because it is a confident record of
 * something that never happened — and a package holding its own connection
 * could not avoid producing one.
 */
export class AuditService {
  constructor(private readonly dataSource: DataSource) {}

  private manager(explicit?: EntityManager): EntityManager {
    return explicit ?? resolveManager(this.dataSource);
  }

  /**
   * Records an action.
   *
   * Actor, tenant, request id, correlation id, address and user agent are all
   * taken from the ambient request context unless overridden, so a caller
   * writes one line and the trail is complete.
   */
  async record(options: RecordOptions, manager?: EntityManager): Promise<AuditLogEntry> {
    const context = getContext();

    const changes =
      options.changes !== undefined
        ? options.changes
        : computeChanges(options.before, options.after, {
            redact: options.redact,
            ignore: options.ignore,
          });

    const entry = this.manager(manager).create(AuditLogEntry, {
      tenantId: options.tenantId !== undefined ? options.tenantId : (context?.tenantId ?? null),
      action: options.action,
      entityType: options.entityType ?? null,
      entityId: options.entityId ?? null,
      actorId: options.actor?.id ?? context?.actor?.id ?? null,
      actorType: options.actor?.type ?? context?.actor?.type ?? null,
      actorName: options.actor?.name ?? context?.actor?.displayName ?? null,
      impersonatedBy: options.actor?.impersonatedBy ?? context?.actor?.impersonatedBy ?? null,
      changes,
      metadata: options.metadata ? redactMetadata(options.metadata, options.redact) : null,
      requestId: context?.requestId ?? null,
      correlationId: context?.correlationId ?? null,
      ip: context?.ip ?? null,
      userAgent: context?.userAgent?.slice(0, 512) ?? null,
      occurredAt: options.occurredAt ?? new Date(),
    });

    return this.manager(manager).save(AuditLogEntry, entry);
  }

  /**
   * Records several actions at once.
   *
   * A bulk operation touching two hundred rows should produce one insert, not
   * two hundred round trips inside the caller's transaction.
   */
  async recordMany(entries: RecordOptions[], manager?: EntityManager): Promise<AuditLogEntry[]> {
    const saved: AuditLogEntry[] = [];
    for (const options of entries) saved.push(await this.record(options, manager));
    return saved;
  }

  /** The trail for one entity, newest first. */
  async forEntity(
    entityType: string,
    entityId: string,
    options: Omit<AuditQuery, 'entityType' | 'entityId'> = {},
  ): Promise<AuditLogEntry[]> {
    return this.query({ ...options, entityType, entityId });
  }

  /** Everything sharing a correlation id — one user action across services. */
  async forCorrelation(correlationId: string): Promise<AuditLogEntry[]> {
    return this.query({ correlationId, limit: 1000 });
  }

  async query(filter: AuditQuery = {}, manager?: EntityManager): Promise<AuditLogEntry[]> {
    const qb = this.manager(manager)
      .createQueryBuilder(AuditLogEntry, 'audit')
      .orderBy('audit.occurredAt', 'DESC')
      .addOrderBy('audit.id', 'DESC')
      .limit(Math.min(filter.limit ?? 100, 1000))
      .offset(filter.offset ?? 0);

    if (filter.tenantId) qb.andWhere('audit.tenantId = :tenantId', { tenantId: filter.tenantId });
    if (filter.entityType)
      qb.andWhere('audit.entityType = :entityType', { entityType: filter.entityType });
    if (filter.entityId) qb.andWhere('audit.entityId = :entityId', { entityId: filter.entityId });
    if (filter.actorId) qb.andWhere('audit.actorId = :actorId', { actorId: filter.actorId });
    if (filter.action) qb.andWhere('audit.action = :action', { action: filter.action });
    if (filter.correlationId)
      qb.andWhere('audit.correlationId = :correlationId', { correlationId: filter.correlationId });
    if (filter.from) qb.andWhere('audit.occurredAt >= :from', { from: filter.from });
    if (filter.to) qb.andWhere('audit.occurredAt <= :to', { to: filter.to });

    return qb.getMany();
  }

  async count(filter: AuditQuery = {}, manager?: EntityManager): Promise<number> {
    const qb = this.manager(manager).createQueryBuilder(AuditLogEntry, 'audit');
    if (filter.tenantId) qb.andWhere('audit.tenantId = :tenantId', { tenantId: filter.tenantId });
    if (filter.entityType)
      qb.andWhere('audit.entityType = :entityType', { entityType: filter.entityType });
    if (filter.entityId) qb.andWhere('audit.entityId = :entityId', { entityId: filter.entityId });
    if (filter.from) qb.andWhere('audit.occurredAt >= :from', { from: filter.from });
    if (filter.to) qb.andWhere('audit.occurredAt <= :to', { to: filter.to });
    return qb.getCount();
  }

  /**
   * Deletes entries older than the cut-off.
   *
   * The only deletion this package performs, and it is bulk and time-based
   * rather than targeted — there is deliberately no way to remove a single
   * inconvenient row. Deleted in batches so a first run against years of
   * history does not hold one long transaction.
   */
  async purgeOlderThan(
    olderThan: Date,
    options: { tenantId?: string; batchSize?: number } = {},
  ): Promise<number> {
    const batchSize = options.batchSize ?? 10_000;
    let deleted = 0;

    for (;;) {
      const qb = this.dataSource
        .createQueryBuilder()
        .delete()
        .from(AuditLogEntry)
        .where(
          `id IN (SELECT id FROM mortar_audit_log WHERE occurred_at < :olderThan ${
            options.tenantId ? 'AND tenant_id = :tenantId' : ''
          } LIMIT :batchSize)`,
          { olderThan, batchSize, ...(options.tenantId ? { tenantId: options.tenantId } : {}) },
        );

      const result = await qb.execute();
      const affected = result.affected ?? 0;
      deleted += affected;
      if (affected < batchSize) break;
    }

    return deleted;
  }
}
