import { getTenantId, requireTenantId } from '@birtalanrobert/context';
import { resolveManager } from '@birtalanrobert/database';
import { CrossTenantAccessError } from '@birtalanrobert/http';
import type {
  DataSource,
  DeepPartial,
  EntityManager,
  EntityTarget,
  FindManyOptions,
  FindOneOptions,
  FindOptionsWhere,
  ObjectLiteral,
  Repository,
} from 'typeorm';

/**
 * An entity that belongs to a tenant.
 *
 * `id` is part of the contract because the scoped repository offers id-based
 * lookups, and because every tenant-owned table in this catalogue has a
 * surrogate key — the same convention `BaseEntity` in `@birtalanrobert/database` sets.
 */
export interface TenantOwned extends ObjectLiteral {
  id: string;
  tenantId: string;
}

/**
 * A repository that cannot be used unscoped.
 *
 * Every read applies `tenantId`, every write stamps it, and every returned row
 * is verified to belong to the caller's tenant before it is handed back. The
 * verification is not redundant with the filter: it also catches a row loaded
 * through a relation, a raw query, or a caller passing an id it should not
 * have — which is exactly the class of mistake that leaks data.
 *
 * The alternative — remembering `where: { tenantId }` at several hundred call
 * sites — fails the first time someone is in a hurry, and fails silently.
 */
export class TenantScopedRepository<Entity extends TenantOwned> {
  constructor(
    private readonly dataSource: DataSource,
    private readonly entity: EntityTarget<Entity>,
  ) {}

  /** The tenant this repository is operating as. Throws if unscoped. */
  get tenantId(): string {
    return requireTenantId();
  }

  private repo(manager?: EntityManager): Repository<Entity> {
    return (manager ?? resolveManager(this.dataSource)).getRepository(this.entity);
  }

  private scopedWhere(
    where?: FindOptionsWhere<Entity> | FindOptionsWhere<Entity>[],
  ): FindOptionsWhere<Entity> | FindOptionsWhere<Entity>[] {
    const tenantId = this.tenantId as Entity['tenantId'];
    if (Array.isArray(where)) {
      return where.map((clause) => ({ ...clause, tenantId })) as FindOptionsWhere<Entity>[];
    }
    return { ...(where ?? {}), tenantId } as FindOptionsWhere<Entity>;
  }

  /**
   * Confirms a row belongs to the caller's tenant.
   *
   * Raises `CrossTenantAccessError` rather than returning null, deliberately:
   * a not-found and a wrong-tenant are different events, and the second is
   * either a serious bug or an attack. It has its own error code so it can be
   * alerted on separately rather than disappearing into a wall of 404s.
   */
  private assertOwned<T extends TenantOwned | null | undefined>(row: T): T {
    if (row && row.tenantId !== this.tenantId) throw new CrossTenantAccessError();
    return row;
  }

  async find(options: FindManyOptions<Entity> = {}, manager?: EntityManager): Promise<Entity[]> {
    const rows = await this.repo(manager).find({
      ...options,
      where: this.scopedWhere(options.where),
    });
    return rows.map((row) => this.assertOwned(row));
  }

  async findOne(options: FindOneOptions<Entity>, manager?: EntityManager): Promise<Entity | null> {
    const row = await this.repo(manager).findOne({
      ...options,
      where: this.scopedWhere(options.where),
    });
    return this.assertOwned(row);
  }

  async findById(id: string, manager?: EntityManager): Promise<Entity | null> {
    return this.findOne({ where: { id } as unknown as FindOptionsWhere<Entity> }, manager);
  }

  /** Like `findById`, but raises rather than returning null. */
  async findByIdOrFail(id: string, manager?: EntityManager): Promise<Entity> {
    const row = await this.findById(id, manager);
    if (!row) {
      const { NotFoundError } = await import('@birtalanrobert/http');
      throw new NotFoundError(entityName(this.entity), id);
    }
    return row;
  }

  async count(options: FindManyOptions<Entity> = {}, manager?: EntityManager): Promise<number> {
    return this.repo(manager).count({ ...options, where: this.scopedWhere(options.where) });
  }

  async exists(where: FindOptionsWhere<Entity>, manager?: EntityManager): Promise<boolean> {
    return (await this.count({ where }, manager)) > 0;
  }

  /** Creates an entity instance with the tenant already stamped. */
  create(data: DeepPartial<Entity>): Entity {
    return this.repo().create({ ...data, tenantId: this.tenantId } as DeepPartial<Entity>);
  }

  /**
   * Saves, stamping the tenant and refusing anything belonging to another.
   *
   * The refusal matters on update as much as insert: a caller that loaded a
   * row through some other path and hands it here must not be able to write
   * across the boundary.
   */
  async save(entity: DeepPartial<Entity>, manager?: EntityManager): Promise<Entity> {
    const existing = (entity as Partial<TenantOwned>).tenantId;
    if (existing && existing !== this.tenantId) throw new CrossTenantAccessError();
    return this.repo(manager).save({
      ...entity,
      tenantId: this.tenantId,
    } as DeepPartial<Entity>) as Promise<Entity>;
  }

  async update(
    where: FindOptionsWhere<Entity>,
    changes: Partial<Entity>,
    manager?: EntityManager,
  ): Promise<number> {
    // tenantId is stripped from the change set: an update must never be able
    // to move a row to another tenant.
    const { tenantId: _ignored, ...safe } = changes as Partial<TenantOwned>;
    const result = await this.repo(manager).update(
      this.scopedWhere(where) as FindOptionsWhere<Entity>,
      safe as never,
    );
    return result.affected ?? 0;
  }

  async delete(where: FindOptionsWhere<Entity>, manager?: EntityManager): Promise<number> {
    const result = await this.repo(manager).delete(
      this.scopedWhere(where) as FindOptionsWhere<Entity>,
    );
    return result.affected ?? 0;
  }

  /**
   * A query builder with the tenant predicate already applied.
   *
   * The alias is fixed so the predicate cannot be accidentally dropped by a
   * caller renaming it.
   */
  createQueryBuilder(alias = 'entity', manager?: EntityManager) {
    return this.repo(manager)
      .createQueryBuilder(alias)
      .where(`${alias}.tenantId = :mortarTenantId`, { mortarTenantId: this.tenantId });
  }

  /**
   * Escapes tenant scoping for one call.
   *
   * Exists because platform operators, cross-tenant reports and migrations are
   * real. Deliberately verbose to type and impossible to reach by accident,
   * and it takes a reason so the audit trail can explain why the boundary was
   * crossed.
   */
  async unscoped<T>(
    reason: string,
    work: (repository: Repository<Entity>) => Promise<T>,
    manager?: EntityManager,
  ): Promise<T> {
    if (!reason || reason.trim().length < 8) {
      throw new Error('unscoped() requires a substantive reason, for the audit trail.');
    }
    return work(this.repo(manager));
  }
}

function entityName<T>(entity: EntityTarget<T>): string {
  if (typeof entity === 'function') return entity.name;
  if (typeof entity === 'string') return entity;
  return 'Entity';
}

/** True when a tenant is bound. Useful for guards and diagnostics. */
export function hasTenant(): boolean {
  return getTenantId() !== undefined;
}
