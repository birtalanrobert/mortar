import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import type { MembershipRole } from './membership-role';
import type { User } from './user';

export type MembershipStatus = 'invited' | 'active' | 'suspended';

/**
 * A user's place in one tenant.
 *
 * Roles are granted through `mortar_membership_role` rather than stored here,
 * so that a role is a referenced entity with integrity behind it rather than a
 * free string nobody validates.
 */
export abstract class BaseMembership {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  /**
   * The tenant this membership belongs to.
   *
   * A plain column with **no relation decorator**, deliberately: mortar does
   * not own a tenant table. Each project defines its own — with its own
   * branding, plan and settings — so there is nothing here for a relation to
   * point at. The foreign key, if a project wants one, belongs in that
   * project's migration.
   */
  @Column({ type: 'uuid' })
  tenantId!: string;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: MembershipStatus;

  /** The actor who invited this member. See `MembershipRole.grantedBy`. */
  @Column({ type: 'varchar', length: 128, nullable: true })
  invitedBy!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  joinedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  // --- relations ---

  @ManyToOne('User', 'memberships', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  /**
   * Role grants.
   *
   * Modelled as a one-to-many onto the explicit join entity rather than as a
   * `@ManyToMany` to `Role`. The join carries `grantedBy` and `grantedAt`,
   * which a many-to-many has nowhere to put — and declaring both would give
   * two writers to one table.
   */
  @OneToMany('MembershipRole', 'membership')
  roleLinks?: MembershipRole[];
}

/**
 * The default `Membership` entity.
 *
 * A project needing extra columns or relations declares its own class
 * extending `BaseMembership` and registers that instead — see the README.
 * The subclass **must keep the name `Membership`**, because mortar's own
 * entities reference it by name; a mismatch fails loudly at boot rather
 * than silently at runtime.
 */
@Entity({ name: 'mortar_membership' })
@Unique('uq_membership_user_tenant', ['userId', 'tenantId'])
@Index('idx_membership_tenant', ['tenantId', 'status'])
export class Membership extends BaseMembership {}
