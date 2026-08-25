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

/**
 * A logged-in session.
 *
 * `tokenHash` holds a digest, never the token. A leaked sessions table full of
 * usable tokens is an immediate compromise of every logged-in user; a table of
 * digests is not.
 */
export abstract class BaseSession {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar', length: 64 })
  tokenHash!: string;

  /**
   * The tenant this session is currently acting in, where applicable.
   *
   * A plain column: mortar owns no tenant table to relate to.
   */
  @Column({ type: 'uuid', nullable: true })
  tenantId!: string | null;

  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  /**
   * Advanced on use, so an idle session can be expired separately from an
   * absolute lifetime — a shared counter tablet left logged in overnight
   * should not stay valid because someone touched it at closing time.
   */
  @Column({ type: 'timestamptz' })
  lastSeenAt!: Date;

  @Column({ type: 'inet', nullable: true })
  ip!: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  userAgent!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  revokedReason!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  // --- relations ---

  @ManyToOne('User', 'sessions', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;
}

/**
 * The default `Session` entity.
 *
 * A project needing extra columns or relations declares its own class
 * extending `BaseSession` and registers that instead — see the README.
 * The subclass **must keep the name `Session`**, because mortar's own
 * entities reference it by name; a mismatch fails loudly at boot rather
 * than silently at runtime.
 */
@Entity({ name: 'mortar_session' })
@Index('uq_session_token', ['tokenHash'], { unique: true })
@Index('idx_session_user', ['userId', 'revokedAt'])
@Index('idx_session_expiry', ['expiresAt'])
export class Session extends BaseSession {}
