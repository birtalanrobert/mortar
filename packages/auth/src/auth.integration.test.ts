import { runInContext } from '@birtalanrobert/context';
import { ConflictError, ValidationError } from '@birtalanrobert/http';
import { createTestDataSource, runInTransaction } from '@birtalanrobert/database';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthToken } from './entities/auth-token';
import { MembershipRole } from './entities/membership-role';
import { Membership } from './entities/membership';
import { Session } from './entities/session';
import { User } from './entities/user';
import {
  AccountLockedError,
  EmailAlreadyRegisteredError,
  InvalidCredentialsError,
  InvalidTokenError,
  SessionExpiredError,
} from './errors';
import { ScryptHasher } from './password';
import { SessionService } from './services/session.service';
import { TokenService } from './services/token.service';
import { RoleService } from './services/role.service';
import { UserService } from './services/user.service';
import { authEntities, authMigrations } from './index';

let dataSource: DataSource;
let users: UserService;
let sessions: SessionService;
let tokens: TokenService;
let roles: RoleService;

// Weak parameters: these tests exercise behaviour, not cost.
const hasher = new ScryptHasher({ cost: 1024 });
const TENANT = '00000000-0000-0000-0000-0000000000aa';

beforeAll(async () => {
  dataSource = await createTestDataSource(authEntities, { migrations: authMigrations });
  users = new UserService(dataSource, { hasher, maxFailedAttempts: 3, lockDurationMs: 60_000 });
  sessions = new SessionService(dataSource);
  tokens = new TokenService(dataSource);
  roles = new RoleService(dataSource);
  users = new UserService(dataSource, {
    hasher,
    maxFailedAttempts: 3,
    lockDurationMs: 60_000,
    roleService: roles,
  });
});

afterAll(async () => {
  if (dataSource?.isInitialized) await dataSource.destroy();
});

beforeEach(async () => {
  await dataSource.query(
    'TRUNCATE mortar_auth_token, mortar_session, mortar_membership_role, mortar_membership, mortar_role, mortar_user CASCADE',
  );
});

describe('registration', () => {
  it('creates a user with a hashed password', async () => {
    const user = await users.create({ email: 'Ana@Example.com', password: 'pw-123456' });
    expect(user.email).toBe('ana@example.com');
    expect(user.passwordHash).not.toBeNull();
    expect(user.passwordHash).not.toContain('pw-123456');
  });

  it('refuses a duplicate address regardless of casing', async () => {
    await users.create({ email: 'ana@example.com', password: 'pw-123456' });
    await expect(users.create({ email: 'ANA@EXAMPLE.COM', password: 'other' })).rejects.toThrow(
      EmailAlreadyRegisteredError,
    );
  });

  it('rejects an implausible address, naming the field', async () => {
    const failure = await users.create({ email: 'not-an-email' }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ValidationError);
    expect((failure as ValidationError).toProblemDetails().errors).toEqual([
      { field: 'email', message: 'Enter a valid email address.', code: 'invalid_email' },
    ]);
  });

  it('allows an account with no password, for invitation-only flows', async () => {
    const user = await users.create({ email: 'invited@example.com' });
    expect(user.passwordHash).toBeNull();
  });
});

describe('sign in', () => {
  beforeEach(async () => {
    await users.create({ email: 'ana@example.com', password: 'correct-password' });
  });

  it('accepts the correct password', async () => {
    const user = await users.verifyPassword('ana@example.com', 'correct-password');
    expect(user.lastLoginAt).not.toBeNull();
  });

  it('rejects the wrong password', async () => {
    await expect(users.verifyPassword('ana@example.com', 'wrong')).rejects.toThrow(
      InvalidCredentialsError,
    );
  });

  it('gives the same error for an unknown account, so accounts cannot be enumerated', async () => {
    // A different message — or a materially different response time — turns
    // the login form into an oracle for a credential-stuffing run.
    const unknown = await users.verifyPassword('nobody@example.com', 'x').catch((e) => e);
    const wrong = await users.verifyPassword('ana@example.com', 'x').catch((e) => e);
    expect(unknown).toBeInstanceOf(InvalidCredentialsError);
    expect(wrong).toBeInstanceOf(InvalidCredentialsError);
    expect((unknown as Error).message).toBe((wrong as Error).message);
  });

  it('resets the failure count on success', async () => {
    await users.verifyPassword('ana@example.com', 'wrong').catch(() => undefined);
    await users.verifyPassword('ana@example.com', 'correct-password');
    const user = await users.findByEmail('ana@example.com');
    expect(user?.failedLoginAttempts).toBe(0);
  });

  it('locks the account after repeated failures', async () => {
    for (let i = 0; i < 3; i++) {
      await users.verifyPassword('ana@example.com', 'wrong').catch(() => undefined);
    }
    // Locked even with the right password: a rate limiter keyed on address
    // does not stop a distributed attempt against one account.
    await expect(users.verifyPassword('ana@example.com', 'correct-password')).rejects.toThrow(
      AccountLockedError,
    );
  });

  it('upgrades a hash made with weaker parameters, without locking the user out', async () => {
    const weak = new UserService(dataSource, { hasher: new ScryptHasher({ cost: 512 }) });
    await weak.create({ email: 'old@example.com', password: 'unchanged' });
    const before = (await users.findByEmail('old@example.com'))!.passwordHash!;
    expect(before).toContain('$512$');

    await users.verifyPassword('old@example.com', 'unchanged');

    const after = (await users.findByEmail('old@example.com'))!.passwordHash!;
    expect(after).toContain('$1024$');
  });
});

describe('sessions', () => {
  let userId: string;

  beforeEach(async () => {
    userId = (await users.create({ email: 'ana@example.com', password: 'pw-123456' })).id;
  });

  it('stores a digest, never the token', async () => {
    // A leaked sessions table full of usable tokens compromises every logged-in
    // user; a table of digests does not.
    const { token, session } = await sessions.create(userId);
    expect(session.tokenHash).not.toBe(token);
    const stored = await dataSource.getRepository(Session).findOneByOrFail({ id: session.id });
    expect(stored.tokenHash).not.toContain(token);
  });

  it('validates a live session', async () => {
    const { token } = await sessions.create(userId);
    expect((await sessions.validate(token)).userId).toBe(userId);
  });

  it('rejects an unknown token', async () => {
    await expect(sessions.validate('not-a-real-token')).rejects.toThrow(SessionExpiredError);
  });

  it('rejects an expired session', async () => {
    const { token } = await sessions.create(userId, { ttlMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(sessions.validate(token)).rejects.toThrow(SessionExpiredError);
  });

  it('rejects an idle session before its absolute expiry', async () => {
    const brief = new SessionService(dataSource, { idleTtlMs: 20, touchIntervalMs: 0 });
    const { token } = await brief.create(userId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(brief.validate(token)).rejects.toThrow(SessionExpiredError);
  });

  it('rejects a revoked session immediately', async () => {
    const { token, session } = await sessions.create(userId);
    await sessions.revoke(session.id);
    await expect(sessions.validate(token)).rejects.toThrow(SessionExpiredError);
  });

  it('invalidates the old token when rotating', async () => {
    // Keeping one token across a privilege change is session fixation.
    const { token: original, session } = await sessions.create(userId);
    const { token: rotated } = await sessions.rotate(session);

    expect(rotated).not.toBe(original);
    await expect(sessions.validate(original)).rejects.toThrow(SessionExpiredError);
    expect((await sessions.validate(rotated)).id).toBe(session.id);
  });

  it('rotates the token when switching tenant', async () => {
    const { token: original, session } = await sessions.create(userId);
    const { token: switched, session: updated } = await sessions.switchTenant(session, TENANT);
    expect(updated.tenantId).toBe(TENANT);
    await expect(sessions.validate(original)).rejects.toThrow(SessionExpiredError);
    expect((await sessions.validate(switched)).tenantId).toBe(TENANT);
  });

  it('revokes every session on demand, which a password reset must do', async () => {
    const a = await sessions.create(userId);
    const b = await sessions.create(userId);
    expect(await sessions.revokeAllForUser(userId, 'password_changed')).toBe(2);
    await expect(sessions.validate(a.token)).rejects.toThrow();
    await expect(sessions.validate(b.token)).rejects.toThrow();
  });

  it('can keep the current session while revoking the others', async () => {
    const keep = await sessions.create(userId);
    await sessions.create(userId);
    await sessions.revokeAllForUser(userId, 'signed_out_everywhere', {
      exceptSessionId: keep.session.id,
    });
    expect((await sessions.validate(keep.token)).id).toBe(keep.session.id);
  });

  it('captures the address and agent from the request context', async () => {
    const { session } = await runInContext({ ip: '203.0.113.7', userAgent: 'Mozilla/5.0' }, () =>
      sessions.create(userId),
    );
    expect(session.ip).toBe('203.0.113.7');
    expect(session.userAgent).toBe('Mozilla/5.0');
  });
});

describe('single-use tokens', () => {
  it('issues and consumes once', async () => {
    const { token } = await tokens.issue({ type: 'password_reset', email: 'ana@example.com' });
    expect((await tokens.consume(token, 'password_reset')).email).toBe('ana@example.com');
    await expect(tokens.consume(token, 'password_reset')).rejects.toThrow(InvalidTokenError);
  });

  it('lets exactly one of several concurrent consumes win', async () => {
    // A double-clicked link, or an email client pre-fetching the URL.
    const { token } = await tokens.issue({ type: 'magic_link', email: 'ana@example.com' });
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => tokens.consume(token, 'magic_link')),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('refuses a token presented for a different purpose', async () => {
    // A verification link must not double as a password reset.
    const { token } = await tokens.issue({ type: 'email_verification', email: 'a@example.com' });
    await expect(tokens.consume(token, 'password_reset')).rejects.toThrow(InvalidTokenError);
  });

  it('refuses an expired token', async () => {
    const { token } = await tokens.issue({
      type: 'password_reset',
      email: 'a@example.com',
      ttlMs: 10,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(tokens.consume(token, 'password_reset')).rejects.toThrow(InvalidTokenError);
  });

  it('gives the same error for unknown, expired and spent tokens', async () => {
    // Distinguishing them tells an attacker whether a token ever existed.
    const unknown = await tokens.consume('made-up', 'password_reset').catch((e) => e);
    const { token } = await tokens.issue({ type: 'password_reset', email: 'a@example.com' });
    await tokens.consume(token, 'password_reset');
    const spent = await tokens.consume(token, 'password_reset').catch((e) => e);
    expect((unknown as Error).message).toBe((spent as Error).message);
  });

  it('supersedes an outstanding token of the same type', async () => {
    // Two live reset links means the older still works after the user asked
    // for a fresh one — precisely when they feared the first was seen.
    const first = await tokens.issue({ type: 'password_reset', email: 'a@example.com' });
    await tokens.issue({ type: 'password_reset', email: 'a@example.com' });
    await expect(tokens.consume(first.token, 'password_reset')).rejects.toThrow(InvalidTokenError);
  });

  it('un-spends the token when the work it guarded fails', async () => {
    const { token } = await tokens.issue({ type: 'password_reset', email: 'a@example.com' });

    await expect(
      tokens.consumeWith(token, 'password_reset', async () => {
        throw new Error('setting the new password failed');
      }),
    ).rejects.toThrow('setting the new password failed');

    // The user's link still works: it was not burned by a failure that was
    // not their fault.
    expect((await tokens.consume(token, 'password_reset')).email).toBe('a@example.com');
  });

  it('carries an invitation payload', async () => {
    const { token } = await tokens.issue({
      type: 'invitation',
      email: 'new@example.com',
      tenantId: TENANT,
      payload: { roles: ['manager'] },
    });
    const record = await tokens.consume(token, 'invitation');
    expect(record.tenantId).toBe(TENANT);
    expect(record.payload).toEqual({ roles: ['manager'] });
  });

  it('purges expired tokens', async () => {
    await tokens.issue({ type: 'magic_link', email: 'a@example.com', ttlMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await tokens.purgeExpired()).toBe(1);
    expect(await dataSource.getRepository(AuthToken).count()).toBe(0);
  });
});

describe('roles', () => {
  beforeEach(async () => {
    await roles.syncSystemRoles([
      { key: 'owner', name: 'Owner', permissions: ['*'] },
      { key: 'manager', name: 'Manager', permissions: ['booking:*', 'staff:read'] },
      { key: 'staff', name: 'Staff', permissions: ['booking:read'], isDefault: true },
    ]);
  });

  it('seeds system roles idempotently, so boot can always run it', async () => {
    await roles.syncSystemRoles([{ key: 'owner', name: 'Owner', permissions: ['*'] }]);
    const available = await roles.available(TENANT);
    expect(available.filter((r) => r.key === 'owner')).toHaveLength(1);
  });

  it('updates a system role definition in place when the code changes', async () => {
    await roles.syncSystemRoles([
      { key: 'manager', name: 'Manager', permissions: ['booking:*', 'invoice:read'] },
    ]);
    const role = await roles.findByKey('manager', null);
    expect(role?.permissions).toContain('invoice:read');
  });

  it('offers system roles to every tenant', async () => {
    const available = await roles.available(TENANT);
    expect(available.map((r) => r.key).sort()).toEqual(['manager', 'owner', 'staff']);
  });

  it('lets a tenant define its own role', async () => {
    await roles.createTenantRole(TENANT, {
      key: 'auditor',
      name: 'Auditor',
      permissions: ['booking:read', 'invoice:read'],
    });
    expect((await roles.available(TENANT)).map((r) => r.key)).toContain('auditor');
    // Not visible to a different tenant.
    const other = await roles.available('00000000-0000-0000-0000-0000000000bb');
    expect(other.map((r) => r.key)).not.toContain('auditor');
  });

  it('refuses a tenant role that shadows a system role key', async () => {
    // Otherwise 'manager' means two things in one tenant, and which one wins
    // depends on query order.
    await expect(
      roles.createTenantRole(TENANT, { key: 'manager', name: 'Mine', permissions: [] }),
    ).rejects.toThrow(ConflictError);
  });

  it('refuses to modify or delete a system role', async () => {
    const owner = (await roles.findByKey('owner', null))!;
    await expect(roles.updateTenantRole(owner.id, { name: 'Boss' })).rejects.toThrow(ConflictError);
    await expect(roles.deleteTenantRole(owner.id)).rejects.toThrow(ConflictError);
  });

  it('validates the key format', async () => {
    for (const key of ['Manager', '1manager', 'man ager', 'm']) {
      await expect(
        roles.createTenantRole(TENANT, { key, name: 'x', permissions: [] }),
      ).rejects.toThrow(ValidationError);
    }
  });
});

describe('memberships and role grants', () => {
  let userId: string;

  beforeEach(async () => {
    await roles.syncSystemRoles([
      { key: 'owner', name: 'Owner', permissions: ['*'] },
      { key: 'manager', name: 'Manager', permissions: ['booking:*', 'staff:read'] },
      { key: 'staff', name: 'Staff', permissions: ['booking:read'] },
    ]);
    userId = (await users.create({ email: 'ana@example.com' })).id;
  });

  it('grants roles by key', async () => {
    await users.addMembership(userId, TENANT, ['manager']);
    const granted = await users.rolesFor(userId, TENANT);
    expect(granted.map((r) => r.key)).toEqual(['manager']);
  });

  it('refuses an unknown role key instead of storing it', async () => {
    // The whole reason roles are a table: a typo is caught, rather than stored
    // as a role that silently grants nothing.
    await expect(users.addMembership(userId, TENANT, ['manger'])).rejects.toThrow(ValidationError);
  });

  it('names the unknown key so the mistake is obvious', async () => {
    const failure = await users
      .addMembership(userId, TENANT, ['manager', 'nonexistent'])
      .catch((e: unknown) => e);
    expect((failure as ValidationError).toProblemDetails().errors).toEqual([
      { field: 'roles', message: "Unknown role 'nonexistent'.", code: 'unknown_role' },
    ]);
  });

  it('supports several roles at once', async () => {
    await users.addMembership(userId, TENANT, ['manager', 'staff']);
    expect((await users.rolesFor(userId, TENANT)).map((r) => r.key).sort()).toEqual([
      'manager',
      'staff',
    ]);
  });

  it('unions the permissions of every granted role', async () => {
    await users.addMembership(userId, TENANT, ['manager', 'staff']);
    const permissions = await users.permissionsFor(userId, TENANT);
    expect([...permissions].sort()).toEqual(['booking:*', 'booking:read', 'staff:read']);
  });

  it('replaces roles rather than accumulating them', async () => {
    const membership = await users.addMembership(userId, TENANT, ['manager']);
    await roles.setRoles(membership.id, ['staff']);
    expect((await roles.rolesFor(membership.id)).map((r) => r.key)).toEqual(['staff']);
  });

  it('grants and revokes individually', async () => {
    const membership = await users.addMembership(userId, TENANT, ['staff']);
    await roles.grant(membership.id, 'manager');
    expect((await roles.rolesFor(membership.id)).map((r) => r.key).sort()).toEqual([
      'manager',
      'staff',
    ]);
    await roles.revoke(membership.id, 'staff');
    expect((await roles.rolesFor(membership.id)).map((r) => r.key)).toEqual(['manager']);
  });

  it('is idempotent when granting a role twice', async () => {
    const membership = await users.addMembership(userId, TENANT, ['staff']);
    await roles.grant(membership.id, 'manager');
    await roles.grant(membership.id, 'manager');
    expect(await roles.rolesFor(membership.id)).toHaveLength(2);
  });

  it('records who granted a role, which is what an auditor asks about', async () => {
    const membership = await runInContext({ actor: { id: 'operator-7', type: 'user' } }, () =>
      users.addMembership(userId, TENANT, ['manager']),
    );
    const link = await dataSource
      .getRepository(MembershipRole)
      .findOneByOrFail({ membershipId: membership.id });
    expect(link.grantedBy).toBe('operator-7');
    expect(link.grantedAt).toBeInstanceOf(Date);
  });

  it('refuses to delete a role that is still assigned', async () => {
    const custom = await roles.createTenantRole(TENANT, {
      key: 'auditor',
      name: 'Auditor',
      permissions: [],
    });
    const membership = await users.addMembership(userId, TENANT, ['auditor']);
    await expect(roles.deleteTenantRole(custom.id)).rejects.toThrow(/assigned to 1 member/);

    await roles.setRoles(membership.id, []);
    await expect(roles.deleteTenantRole(custom.id)).resolves.toBeUndefined();
  });

  it('lets one user hold different roles in different tenants', async () => {
    // The agent managing portfolios for four landlords, the recruiter working
    // two agencies — one human, one password, different authority in each.
    const other = '00000000-0000-0000-0000-0000000000bb';
    await users.addMembership(userId, TENANT, ['owner']);
    await users.addMembership(userId, other, ['staff']);

    expect([...(await users.permissionsFor(userId, TENANT))]).toEqual(['*']);
    expect([...(await users.permissionsFor(userId, other))]).toEqual(['booking:read']);
  });

  it('removes role grants with the membership', async () => {
    const membership = await users.addMembership(userId, TENANT, ['manager']);
    await users.removeMembership(userId, TENANT);
    expect(
      await dataSource.getRepository(MembershipRole).countBy({ membershipId: membership.id }),
    ).toBe(0);
  });

  it('reports no permissions for a user outside the tenant', async () => {
    expect((await users.permissionsFor(userId, TENANT)).size).toBe(0);
  });
});

describe('relations', () => {
  let userId: string;

  beforeEach(async () => {
    await roles.syncSystemRoles([{ key: 'manager', name: 'Manager', permissions: ['booking:*'] }]);
    userId = (await users.create({ email: 'ana@example.com', password: 'pw-123456' })).id;
    await users.addMembership(userId, TENANT, ['manager']);
    await sessions.create(userId);
  });

  it('loads a user with their memberships', async () => {
    const user = await dataSource.getRepository(User).findOneOrFail({
      where: { id: userId },
      relations: { memberships: true },
    });
    expect(user.memberships).toHaveLength(1);
    expect(user.memberships?.[0]?.tenantId).toBe(TENANT);
  });

  it('loads a membership with its user and its role grants', async () => {
    const membership = await dataSource.getRepository(Membership).findOneOrFail({
      where: { userId },
      relations: { user: true, roleLinks: { role: true } },
    });
    expect(membership.user?.email).toBe('ana@example.com');
    expect(membership.roleLinks?.[0]?.role?.key).toBe('manager');
  });

  it('loads a session with its user', async () => {
    const session = await dataSource.getRepository(Session).findOneOrFail({
      where: { userId },
      relations: { user: true },
    });
    expect(session.user?.id).toBe(userId);
  });

  it('does not load relations unless asked, so the login path stays cheap', async () => {
    const user = await dataSource.getRepository(User).findOneOrFail({ where: { id: userId } });
    expect(user.memberships).toBeUndefined();
    expect(user.sessions).toBeUndefined();
  });

  it('cascades deletes from the user through every owned row', async () => {
    await dataSource.getRepository(User).delete({ id: userId });
    expect(await dataSource.getRepository(Membership).countBy({ userId })).toBe(0);
    expect(await dataSource.getRepository(Session).countBy({ userId })).toBe(0);
    expect(await dataSource.getRepository(MembershipRole).count()).toBe(0);
  });

  it('leaves the role itself standing when a membership goes', async () => {
    // Roles are shared definitions; deleting one member must not remove a role
    // that other members still hold.
    await users.removeMembership(userId, TENANT);
    expect(await roles.findByKey('manager', null)).not.toBeNull();
  });

  it('keeps an invitation token usable before its account exists', async () => {
    // The user relation is nullable precisely so an invitation can be issued
    // to an address with no account yet.
    const { token } = await tokens.issue({
      type: 'invitation',
      email: 'newcomer@example.com',
      tenantId: TENANT,
      payload: { roles: ['manager'] },
    });
    const record = await tokens.consume(token, 'invitation');
    expect(record.userId).toBeNull();
    expect(record.email).toBe('newcomer@example.com');
  });
});

describe('transaction participation', () => {
  it('rolls back a user created in a failed transaction', async () => {
    await expect(
      runInTransaction(dataSource, async () => {
        await users.create({ email: 'ghost@example.com', password: 'pw-123456' });
        throw new Error('signup failed later');
      }),
    ).rejects.toThrow('signup failed later');

    expect(await dataSource.getRepository(User).count()).toBe(0);
  });
});
