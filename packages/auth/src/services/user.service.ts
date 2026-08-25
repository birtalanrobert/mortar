import { resolveManager } from '@birtalanrobert/database';
import type { DataSource, EntityManager } from 'typeorm';
import { type BaseUser, type UserStatus } from '../entities/user';
import type { BaseMembership } from '../entities/membership';
import { RoleService } from './role.service';
import { resolveRegistry, type AuthEntityRegistry } from '../registry';
import { ValidationError } from '@birtalanrobert/http';
import {
  AccountLockedError,
  AccountSuspendedError,
  EmailAlreadyRegisteredError,
  InvalidCredentialsError,
} from '../errors';
import { isPlausibleEmail, normaliseEmail } from '../email';
import { defaultPasswordHasher, type PasswordHasher } from '../password';

export interface UserServiceOptions {
  hasher?: PasswordHasher;
  /** Override when the project registers its own entity subclasses. */
  entities?: Partial<AuthEntityRegistry>;
  /** Supply to share one instance; otherwise one is created. */
  roleService?: RoleService;
  /** Failed attempts before a temporary lock. Default 10. */
  maxFailedAttempts?: number;
  /** How long the lock lasts. Default 15 minutes. */
  lockDurationMs?: number;
}

export interface CreateUserInput {
  email: string;
  password?: string;
  displayName?: string;
  locale?: string;
  emailVerified?: boolean;
}

export class UserService {
  private readonly hasher: PasswordHasher;
  private readonly entities: AuthEntityRegistry;
  private readonly roles: RoleService;
  private readonly maxFailedAttempts: number;
  private readonly lockDurationMs: number;

  constructor(
    private readonly dataSource: DataSource,
    options: UserServiceOptions = {},
  ) {
    this.hasher = options.hasher ?? defaultPasswordHasher;
    this.entities = resolveRegistry(options.entities);
    this.roles = options.roleService ?? new RoleService(dataSource);
    this.maxFailedAttempts = options.maxFailedAttempts ?? 10;
    this.lockDurationMs = options.lockDurationMs ?? 15 * 60 * 1000;
  }

  private manager(explicit?: EntityManager): EntityManager {
    return explicit ?? resolveManager(this.dataSource);
  }

  async create(input: CreateUserInput, manager?: EntityManager): Promise<BaseUser> {
    const email = normaliseEmail(input.email);
    if (!isPlausibleEmail(email)) {
      throw new ValidationError([
        { field: 'email', message: 'Enter a valid email address.', code: 'invalid_email' },
      ]);
    }

    const em = this.manager(manager);
    if (await em.findOne(this.entities.user, { where: { email } })) {
      throw new EmailAlreadyRegisteredError();
    }

    const user = em.create(this.entities.user, {
      email,
      passwordHash: input.password ? await this.hasher.hash(input.password) : null,
      displayName: input.displayName ?? null,
      locale: input.locale ?? null,
      emailVerifiedAt: input.emailVerified ? new Date() : null,
      status: 'active' as UserStatus,
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: null,
    });

    return em.save(this.entities.user, user);
  }

  async findByEmail(email: string, manager?: EntityManager): Promise<BaseUser | null> {
    return this.manager(manager).findOne(this.entities.user, {
      where: { email: normaliseEmail(email) },
    });
  }

  async findById(id: string, manager?: EntityManager): Promise<BaseUser | null> {
    return this.manager(manager).findOne(this.entities.user, { where: { id } });
  }

  /**
   * Verifies a password and reports the outcome.
   *
   * Runs the hasher even when the account does not exist, against a dummy
   * hash. Without that, "no such user" returns in a millisecond while a real
   * account takes a hundred — and the difference is a reliable account
   * enumeration oracle regardless of how carefully the error message is worded.
   */
  async verifyPassword(
    email: string,
    password: string,
    manager?: EntityManager,
  ): Promise<BaseUser> {
    const em = this.manager(manager);
    const user = await em.findOne(this.entities.user, { where: { email: normaliseEmail(email) } });

    if (!user?.passwordHash) {
      await this.hasher.verify(password, DUMMY_HASH);
      throw new InvalidCredentialsError();
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new AccountLockedError(user.lockedUntil);
    }

    const valid = await this.hasher.verify(password, user.passwordHash);

    if (!valid) {
      await this.recordFailure(user, em);
      throw new InvalidCredentialsError();
    }

    if (user.status === 'suspended' || user.status === 'deactivated') {
      throw new AccountSuspendedError();
    }

    // Transparent upgrade: raising the cost must not lock anyone out, so old
    // hashes verify against their own parameters and are replaced here.
    if (this.hasher.needsRehash(user.passwordHash)) {
      user.passwordHash = await this.hasher.hash(password);
    }

    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
    user.lastLoginAt = new Date();
    return em.save(this.entities.user, user);
  }

  private async recordFailure(user: BaseUser, em: EntityManager): Promise<void> {
    user.failedLoginAttempts += 1;
    if (user.failedLoginAttempts >= this.maxFailedAttempts) {
      user.lockedUntil = new Date(Date.now() + this.lockDurationMs);
      user.failedLoginAttempts = 0;
    }
    await em.save(this.entities.user, user);
  }

  async setPassword(userId: string, password: string, manager?: EntityManager): Promise<void> {
    const em = this.manager(manager);
    await em.update(
      this.entities.user,
      { id: userId },
      {
        passwordHash: await this.hasher.hash(password),
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    );
  }

  async markEmailVerified(userId: string, manager?: EntityManager): Promise<void> {
    await this.manager(manager).update(
      this.entities.user,
      { id: userId },
      { emailVerifiedAt: new Date() },
    );
  }

  async setStatus(userId: string, status: UserStatus, manager?: EntityManager): Promise<void> {
    await this.manager(manager).update(this.entities.user, { id: userId }, { status });
  }

  // --- memberships ---

  /**
   * Adds a user to a tenant, granting the named roles.
   *
   * Role keys are resolved against `mortar_role`, so an unknown key is refused
   * rather than stored as something that silently grants nothing.
   */
  async addMembership(
    userId: string,
    tenantId: string,
    roleKeys: string[] = [],
    options: { invitedBy?: string; status?: BaseMembership['status'] } = {},
    manager?: EntityManager,
  ): Promise<BaseMembership> {
    const em = this.manager(manager);
    const existing = await em.findOne(this.entities.membership, { where: { userId, tenantId } });

    const membership =
      existing ??
      (await em.save(
        this.entities.membership,
        em.create(this.entities.membership, {
          userId,
          tenantId,
          status: options.status ?? 'active',
          invitedBy: options.invitedBy ?? null,
          joinedAt: options.status === 'invited' ? null : new Date(),
        }),
      ));

    if (existing && options.status) {
      existing.status = options.status;
      await em.save(this.entities.membership, existing);
    }

    await this.roles.setRoles(membership.id, roleKeys, em);
    return membership;
  }

  /** The roles a user holds in a tenant. */
  async rolesFor(userId: string, tenantId: string, manager?: EntityManager) {
    const membership = await this.membership(userId, tenantId, manager);
    return membership ? this.roles.rolesFor(membership.id, manager) : [];
  }

  /**
   * The permissions a user holds in a tenant.
   *
   * Resolved once at sign-in and carried on the actor, so every subsequent
   * permission check is an in-memory set lookup rather than a join.
   */
  async permissionsFor(
    userId: string,
    tenantId: string,
    manager?: EntityManager,
  ): Promise<Set<string>> {
    const membership = await this.membership(userId, tenantId, manager);
    return membership ? this.roles.permissionsFor(membership.id, manager) : new Set<string>();
  }

  async membershipsFor(userId: string, manager?: EntityManager): Promise<BaseMembership[]> {
    return this.manager(manager).find(this.entities.membership, { where: { userId } });
  }

  async membership(
    userId: string,
    tenantId: string,
    manager?: EntityManager,
  ): Promise<BaseMembership | null> {
    return this.manager(manager).findOne(this.entities.membership, { where: { userId, tenantId } });
  }

  async removeMembership(userId: string, tenantId: string, manager?: EntityManager): Promise<void> {
    await this.manager(manager).delete(this.entities.membership, { userId, tenantId });
  }
}

/**
 * A real hash of a value nobody knows, used to spend the same time verifying a
 * password for an account that does not exist.
 */
const DUMMY_HASH =
  'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' +
  'ZGVsaWJlcmF0ZWx5LWludmFsaWQtZGlnZXN0LXVzZWQtb25seS10by1zcGVuZC10aW1lLXh4eHg=';
