import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { AuthToken } from './auth-token';
import type { Membership } from './membership';
import type { Session } from './session';

export type UserStatus = 'active' | 'suspended' | 'deactivated';

/**
 * A person, globally.
 *
 * Deliberately **not** tenant-scoped. Several projects in this catalogue have
 * one human belonging to several tenants — an agent managing portfolios for
 * four landlords, a recruiter working two agencies, an operator supporting
 * everybody — and a user-per-tenant model forces them into separate accounts
 * with separate passwords. Tenant membership lives in `mortar_membership`.
 */
export abstract class BaseUser {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Stored lower-cased; see `normaliseEmail`. */
  @Column({ type: 'varchar', length: 320 })
  email!: string;

  @Column({ type: 'timestamptz', nullable: true })
  emailVerifiedAt!: Date | null;

  /** Null for accounts that authenticate only by link or invitation. */
  @Column({ type: 'text', nullable: true })
  passwordHash!: string | null;

  @Column({ type: 'varchar', length: 256, nullable: true })
  displayName!: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  locale!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: UserStatus;

  /**
   * Consecutive failed attempts, reset on success.
   *
   * Throttling lives here rather than only in a rate limiter because a limiter
   * keyed on address does not stop a distributed attempt against one account.
   */
  @Column({ type: 'int', default: 0 })
  failedLoginAttempts!: number;

  @Column({ type: 'timestamptz', nullable: true })
  lockedUntil!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastLoginAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  // --- relations ---
  //
  // Declared but never eager: loading every session and token whenever a user
  // is read would make the login path pay for data it does not use. Callers
  // ask for them explicitly with `relations: { … }`.

  @OneToMany('Membership', 'user')
  memberships?: Membership[];

  @OneToMany('Session', 'user')
  sessions?: Session[];

  @OneToMany('AuthToken', 'user')
  tokens?: AuthToken[];
}

/**
 * The default `User` entity.
 *
 * A project needing extra columns or relations declares its own class
 * extending `BaseUser` and registers that instead — see the README.
 * The subclass **must keep the name `User`**, because mortar's own
 * entities reference it by name; a mismatch fails loudly at boot rather
 * than silently at runtime.
 */
@Entity({ name: 'mortar_user' })
@Index('uq_user_email', ['email'], { unique: true })
export class User extends BaseUser {}
