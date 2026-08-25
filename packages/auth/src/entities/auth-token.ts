import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { User } from './user';

export type AuthTokenType = 'email_verification' | 'password_reset' | 'invitation' | 'magic_link';

/**
 * A single-use token: verification, reset, invitation or magic link.
 *
 * One table with a type discriminator rather than four near-identical ones —
 * they share every field, every lifecycle rule and every security property,
 * and splitting them would mean fixing the same bug four times.
 */
export abstract class BaseAuthToken {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 32 })
  type!: AuthTokenType;

  @Column({ type: 'varchar', length: 64 })
  tokenHash!: string;

  /** Null for an invitation to an address that has no account yet. */
  @Column({ type: 'uuid', nullable: true })
  userId!: string | null;

  /** The address this token was issued to, lower-cased. */
  @Column({ type: 'varchar', length: 320 })
  email!: string;

  /**
   * For invitations: the tenant being joined.
   *
   * A plain column: mortar owns no tenant table to relate to.
   */
  @Column({ type: 'uuid', nullable: true })
  tenantId!: string | null;

  /** Type-specific extras — roles for an invitation, a redirect path. */
  @Column({ type: 'jsonb', nullable: true })
  payload!: Record<string, unknown> | null;

  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  /** Set on use. Non-null means spent; tokens are strictly single-use. */
  @Column({ type: 'timestamptz', nullable: true })
  consumedAt!: Date | null;

  /** The actor who issued this. See `MembershipRole.grantedBy`. */
  @Column({ type: 'varchar', length: 128, nullable: true })
  createdBy!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  // --- relations ---

  /**
   * Optional, because an invitation is issued to an email address that may
   * have no account yet — which is the entire point of an invitation.
   */
  @ManyToOne('User', 'tokens', { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'user_id' })
  user?: User;
}

/**
 * The default `AuthToken` entity.
 *
 * A project needing extra columns or relations declares its own class
 * extending `BaseAuthToken` and registers that instead — see the README.
 * The subclass **must keep the name `AuthToken`**, because mortar's own
 * entities reference it by name; a mismatch fails loudly at boot rather
 * than silently at runtime.
 */
@Entity({ name: 'mortar_auth_token' })
@Index('uq_auth_token_hash', ['tokenHash'], { unique: true })
@Index('idx_auth_token_lookup', ['type', 'email'])
@Index('idx_auth_token_expiry', ['expiresAt'])
export class AuthToken extends BaseAuthToken {}
