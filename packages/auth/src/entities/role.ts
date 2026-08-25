import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import type { MembershipRole } from './membership-role';

/**
 * A named set of permissions.
 *
 * A real table rather than a string on the membership, because a role has
 * identity and attributes: a display name for a picker, a description for the
 * admin who has to choose between two of them, and the permissions it grants.
 * Storing bare strings means `'manger'` is accepted silently, grants nothing,
 * and cannot be renamed or enumerated.
 *
 * **Scope.** `tenantId` is null for a *system* role — one the project defines
 * and every tenant gets. A non-null `tenantId` is a role that one tenant
 * created for itself, which several projects in this catalogue genuinely need.
 */
export abstract class BaseRole {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Null for a system role available to every tenant.
   *
   * A plain column with no relation decorator: mortar does not own a tenant
   * table, so there is nothing here for a relation to point at.
   */
  @Column({ type: 'uuid', nullable: true })
  tenantId!: string | null;

  /**
   * Stable machine identifier, e.g. `manager`.
   *
   * Referenced by code and by seeds; never shown to a user, and never renamed
   * — that is what `name` is for.
   */
  @Column({ type: 'varchar', length: 64 })
  key!: string;

  /** Shown in role pickers and member lists. Safe to change. */
  @Column({ type: 'varchar', length: 128 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  /**
   * The permissions this role grants.
   *
   * An array rather than a further join table, deliberately. Roles are
   * *entities* — they have identity, are referenced by other rows, and are
   * renamed and listed. Permissions are *values*: bare strings defined in
   * application code with no identity of their own, no attributes, and nothing
   * ever pointing at them. A `role_permission` table would add a join to every
   * lookup to model something that is simply a list.
   */
  @Column({ type: 'text', array: true, default: () => "'{}'" })
  permissions!: string[];

  /**
   * True for roles the project ships and manages through seeds.
   *
   * System roles cannot be edited or deleted by a tenant: an owner who removes
   * a permission from `owner` locks themselves out of their own account, and
   * the support ticket that follows is unrecoverable without direct database
   * access.
   */
  @Column({ type: 'boolean', default: false })
  isSystem!: boolean;

  /** Assigned automatically to a new member when no role is specified. */
  @Column({ type: 'boolean', default: false })
  isDefault!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  // --- relations ---

  /** Every grant of this role. Consulted before allowing a delete. */
  @OneToMany('MembershipRole', 'role')
  membershipLinks?: MembershipRole[];
}

/**
 * The default `Role` entity.
 *
 * A project needing extra columns or relations declares its own class
 * extending `BaseRole` and registers that instead — see the README.
 * The subclass **must keep the name `Role`**, because mortar's own
 * entities reference it by name; a mismatch fails loudly at boot rather
 * than silently at runtime.
 */
@Entity({ name: 'mortar_role' })
@Unique('uq_role_tenant_key', ['tenantId', 'key'])
@Index('idx_role_tenant', ['tenantId'])
export class Role extends BaseRole {}
