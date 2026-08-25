import { getContext } from '@mortar/context';
import { resolveManager } from '@mortar/database';
import { ConflictError, NotFoundError, ValidationError } from '@mortar/http';
import { IsNull, type DataSource, type EntityManager } from 'typeorm';

import type { BaseRole } from '../entities/role';
import { resolveRegistry, type AuthEntityRegistry } from '../registry';

export interface RoleDefinition {
  key: string;
  name: string;
  description?: string;
  permissions: string[];
  /** Assigned to a new member when none is specified. At most one per scope. */
  isDefault?: boolean;
}

/**
 * Defines roles, grants them, and resolves what they permit.
 *
 * Mortar owns the shape; projects own the contents. A shared enumeration of
 * roles would be wrong within two projects — a "manager" in a repair shop and
 * a "manager" in a recruitment agency have nothing in common — so the project
 * seeds its system roles at boot and mortar guarantees the integrity.
 */
export interface RoleServiceOptions {
  /** Override when the project registers its own entity subclasses. */
  entities?: Partial<AuthEntityRegistry>;
}

export class RoleService {
  private readonly entities: AuthEntityRegistry;

  constructor(
    private readonly dataSource: DataSource,
    options: RoleServiceOptions = {},
  ) {
    this.entities = resolveRegistry(options.entities);
  }

  private manager(explicit?: EntityManager): EntityManager {
    return explicit ?? resolveManager(this.dataSource);
  }

  /**
   * Creates or updates the project's system roles.
   *
   * Idempotent, so it is safe to run on every boot — which is how the
   * definitions stay in step with the code that references them, rather than
   * drifting until someone notices a permission was never granted.
   */
  async syncSystemRoles(
    definitions: RoleDefinition[],
    manager?: EntityManager,
  ): Promise<BaseRole[]> {
    const em = this.manager(manager);
    const synced: BaseRole[] = [];

    for (const definition of definitions) {
      assertKey(definition.key);
      const existing = await em.findOne(this.entities.role, {
        where: { tenantId: IsNull(), key: definition.key },
      });

      const role =
        existing ??
        em.create(this.entities.role, { tenantId: null, key: definition.key, isSystem: true });

      role.name = definition.name;
      role.description = definition.description ?? null;
      role.permissions = definition.permissions;
      role.isDefault = definition.isDefault ?? false;
      role.isSystem = true;

      synced.push(await em.save(this.entities.role, role));
    }

    return synced;
  }

  /** Creates a tenant-specific role. */
  async createTenantRole(
    tenantId: string,
    definition: RoleDefinition,
    manager?: EntityManager,
  ): Promise<BaseRole> {
    assertKey(definition.key);
    const em = this.manager(manager);

    const clash = await em.findOne(this.entities.role, {
      where: [
        { tenantId, key: definition.key },
        { tenantId: IsNull(), key: definition.key },
      ],
    });
    if (clash) {
      // Shadowing a system role key would make `manager` mean two things in
      // one tenant, and which one won would depend on query order.
      throw new ConflictError(`A role with the key '${definition.key}' already exists.`);
    }

    return em.save(
      this.entities.role,
      em.create(this.entities.role, {
        tenantId,
        key: definition.key,
        name: definition.name,
        description: definition.description ?? null,
        permissions: definition.permissions,
        isSystem: false,
        isDefault: definition.isDefault ?? false,
      }),
    );
  }

  async updateTenantRole(
    roleId: string,
    changes: Partial<Pick<BaseRole, 'name' | 'description' | 'permissions' | 'isDefault'>>,
    manager?: EntityManager,
  ): Promise<BaseRole> {
    const em = this.manager(manager);
    const role = await em.findOne(this.entities.role, { where: { id: roleId } });
    if (!role) throw new NotFoundError('Role', roleId);
    if (role.isSystem) {
      // An owner who strips a permission from `owner` locks themselves out,
      // and the resulting ticket needs direct database access to fix.
      throw new ConflictError('System roles cannot be modified.');
    }
    Object.assign(role, changes);
    return em.save(this.entities.role, role);
  }

  async deleteTenantRole(roleId: string, manager?: EntityManager): Promise<void> {
    const em = this.manager(manager);
    const role = await em.findOne(this.entities.role, { where: { id: roleId } });
    if (!role) throw new NotFoundError('Role', roleId);
    if (role.isSystem) throw new ConflictError('System roles cannot be deleted.');

    const inUse = await em.count(this.entities.membershipRole, { where: { roleId } });
    if (inUse > 0) {
      throw new ConflictError(
        `This role is assigned to ${inUse} member(s). Reassign them before deleting it.`,
      );
    }
    await em.delete(this.entities.role, { id: roleId });
  }

  /** Every role available in a tenant: the system roles plus its own. */
  async available(tenantId: string, manager?: EntityManager): Promise<BaseRole[]> {
    return this.manager(manager).find(this.entities.role, {
      where: [{ tenantId: IsNull() }, { tenantId }],
      order: { isSystem: 'DESC', name: 'ASC' },
    });
  }

  async findByKey(
    key: string,
    tenantId: string | null,
    manager?: EntityManager,
  ): Promise<BaseRole | null> {
    const em = this.manager(manager);
    // A tenant's own role takes precedence over a system role of the same key.
    if (tenantId) {
      const own = await em.findOne(this.entities.role, { where: { tenantId, key } });
      if (own) return own;
    }
    return em.findOne(this.entities.role, { where: { tenantId: IsNull(), key } });
  }

  /**
   * Replaces a membership's roles with exactly those listed.
   *
   * Replacement rather than addition, because the caller is a role editor
   * showing checkboxes: "these are the roles now" is the operation that screen
   * actually performs, and expressing it as add-plus-remove invites the two
   * halves to diverge.
   */
  async setRoles(
    membershipId: string,
    roleKeys: string[],
    manager?: EntityManager,
  ): Promise<BaseRole[]> {
    const em = this.manager(manager);
    const membership = await em.findOne(this.entities.membership, { where: { id: membershipId } });
    if (!membership) throw new NotFoundError('Membership', membershipId);

    const roles = await this.resolveKeys(roleKeys, membership.tenantId, em);

    await em.delete(this.entities.membershipRole, { membershipId });
    if (roles.length > 0) {
      await em.save(
        this.entities.membershipRole,
        roles.map((role) =>
          em.create(this.entities.membershipRole, {
            membershipId,
            roleId: role.id,
            grantedBy: getContext()?.actor?.id ?? null,
          }),
        ),
      );
    }

    return roles;
  }

  async grant(membershipId: string, roleKey: string, manager?: EntityManager): Promise<BaseRole> {
    const em = this.manager(manager);
    const membership = await em.findOne(this.entities.membership, { where: { id: membershipId } });
    if (!membership) throw new NotFoundError('Membership', membershipId);

    const [role] = await this.resolveKeys([roleKey], membership.tenantId, em);
    await em
      .createQueryBuilder()
      .insert()
      .into(this.entities.membershipRole)
      .values({ membershipId, roleId: role!.id, grantedBy: getContext()?.actor?.id ?? null })
      .orIgnore()
      .execute();
    return role!;
  }

  async revoke(membershipId: string, roleKey: string, manager?: EntityManager): Promise<void> {
    const em = this.manager(manager);
    const membership = await em.findOne(this.entities.membership, { where: { id: membershipId } });
    if (!membership) throw new NotFoundError('Membership', membershipId);

    const role = await this.findByKey(roleKey, membership.tenantId, em);
    if (role) await em.delete(this.entities.membershipRole, { membershipId, roleId: role.id });
  }

  /**
   * The roles granted to a membership.
   *
   * One query with a join, via the relation, rather than fetching the links
   * and then fetching the roles they point at.
   */
  async rolesFor(membershipId: string, manager?: EntityManager): Promise<BaseRole[]> {
    const links = await this.manager(manager).find(this.entities.membershipRole, {
      where: { membershipId },
      relations: { role: true },
    });
    return links.map((link) => link.role).filter((role): role is BaseRole => role !== undefined);
  }

  /**
   * The union of permissions a membership holds.
   *
   * Resolved once at authentication and carried on the actor, so the guard on
   * every subsequent request is an in-memory set lookup rather than a join.
   */
  async permissionsFor(membershipId: string, manager?: EntityManager): Promise<Set<string>> {
    const roles = await this.rolesFor(membershipId, manager);
    const permissions = new Set<string>();
    for (const role of roles) {
      for (const permission of role.permissions) permissions.add(permission);
    }
    return permissions;
  }

  /** The default role for a tenant, if one is defined. */
  async defaultRole(tenantId: string, manager?: EntityManager): Promise<BaseRole | null> {
    const em = this.manager(manager);
    return (
      (await em.findOne(this.entities.role, { where: { tenantId, isDefault: true } })) ??
      (await em.findOne(this.entities.role, { where: { tenantId: IsNull(), isDefault: true } }))
    );
  }

  private async resolveKeys(
    keys: string[],
    tenantId: string,
    em: EntityManager,
  ): Promise<BaseRole[]> {
    const resolved: BaseRole[] = [];
    const missing: string[] = [];

    for (const key of keys) {
      const role = await this.findByKey(key, tenantId, em);
      if (role) resolved.push(role);
      else missing.push(key);
    }

    if (missing.length > 0) {
      // The whole point of the table: a typo is refused rather than stored as
      // a role that silently grants nothing.
      throw new ValidationError(
        missing.map((key) => ({
          field: 'roles',
          message: `Unknown role '${key}'.`,
          code: 'unknown_role',
        })),
      );
    }

    return resolved;
  }
}

function assertKey(key: string): void {
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(key)) {
    throw new ValidationError([
      {
        field: 'key',
        message:
          'A role key must be lower-case letters, digits and underscores, starting with a letter.',
        code: 'invalid_role_key',
      },
    ]);
  }
}
