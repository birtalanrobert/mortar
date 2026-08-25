import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import type { Membership } from './membership';
import type { Role } from './role';

/**
 * Grants one role to one membership.
 *
 * An explicit join entity rather than an implicit many-to-many, because who
 * granted a role and when is genuinely wanted — role escalation is exactly the
 * change an auditor asks about, and an implicit join table has nowhere to
 * record it.
 */
export abstract class BaseMembershipRole {
  @PrimaryColumn({ type: 'uuid' })
  membershipId!: string;

  @PrimaryColumn({ type: 'uuid' })
  roleId!: string;

  /**
   * The actor who performed this, from the request context.
   *
   * A free string rather than a uuid foreign key: the actor may be a system
   * process seeding roles at boot, a service credential, or an operator acting
   * through impersonation — none of which is a row in `mortar_user`.
   */
  @Column({ type: 'varchar', length: 128, nullable: true })
  grantedBy!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  grantedAt!: Date;

  // --- relations ---

  @ManyToOne('Membership', 'roleLinks', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'membership_id' })
  membership?: Membership;

  /**
   * `RESTRICT`, not `CASCADE`: deleting a role that people still hold would
   * silently strip their access. The service refuses the delete and names the
   * count instead.
   */
  @ManyToOne('Role', 'membershipLinks', { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'role_id' })
  role?: Role;
}

/**
 * The default `MembershipRole` entity.
 *
 * A project needing extra columns or relations declares its own class
 * extending `BaseMembershipRole` and registers that instead — see the README.
 * The subclass **must keep the name `MembershipRole`**, because mortar's own
 * entities reference it by name; a mismatch fails loudly at boot rather
 * than silently at runtime.
 */
@Entity({ name: 'mortar_membership_role' })
@Index('idx_membership_role_role', ['roleId'])
export class MembershipRole extends BaseMembershipRole {}
