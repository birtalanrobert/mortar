import type { DataSource, EntityTarget } from 'typeorm';
import { AuthToken, type BaseAuthToken } from './entities/auth-token';
import { Membership, type BaseMembership } from './entities/membership';
import { MembershipRole, type BaseMembershipRole } from './entities/membership-role';
import { Role, type BaseRole } from './entities/role';
import { Session, type BaseSession } from './entities/session';
import { User, type BaseUser } from './entities/user';

/**
 * Which concrete entity classes the services should use.
 *
 * A project that extends a base class registers its own subclass here, so that
 * mortar's services read and write the project's entity rather than the
 * default — otherwise two classes would map the same table and TypeORM would
 * have to guess which one a query meant.
 */
export interface AuthEntityRegistry {
  user: EntityTarget<BaseUser>;
  membership: EntityTarget<BaseMembership>;
  role: EntityTarget<BaseRole>;
  membershipRole: EntityTarget<BaseMembershipRole>;
  session: EntityTarget<BaseSession>;
  authToken: EntityTarget<BaseAuthToken>;
}

/** Mortar's own entities, used when a project needs no extension. */
export const defaultAuthEntityRegistry: AuthEntityRegistry = {
  user: User,
  membership: Membership,
  role: Role,
  membershipRole: MembershipRole,
  session: Session,
  authToken: AuthToken,
};

export function resolveRegistry(overrides: Partial<AuthEntityRegistry> = {}): AuthEntityRegistry {
  return { ...defaultAuthEntityRegistry, ...overrides };
}

/** The class name each registry slot must carry. */
const REQUIRED_NAMES: Record<keyof AuthEntityRegistry, string> = {
  user: 'User',
  membership: 'Membership',
  role: 'Role',
  membershipRole: 'MembershipRole',
  session: 'Session',
  authToken: 'AuthToken',
};

/**
 * Verifies the registered entities are wired correctly.
 *
 * Two mistakes are worth catching at boot rather than in production:
 *
 * - **A renamed subclass.** Mortar's own entities reference each other by
 *   class name, so a subclass called `AppUser` leaves `Membership.user`
 *   unresolvable. TypeORM does report this, but as an obscure metadata error
 *   far from its cause.
 * - **Both classes registered.** If a project registers its subclass *and*
 *   mortar's default, two entities map one table and queries become a
 *   coin toss.
 */
export function assertAuthEntitiesValid(
  dataSource: DataSource,
  registry: AuthEntityRegistry,
): void {
  const problems: string[] = [];

  for (const [slot, target] of Object.entries(registry) as Array<
    [keyof AuthEntityRegistry, EntityTarget<object>]
  >) {
    const expected = REQUIRED_NAMES[slot];
    const actual = typeof target === 'function' ? target.name : String(target);

    if (actual !== expected) {
      problems.push(
        `The '${slot}' entity is called '${actual}', but must be called '${expected}'. ` +
          `Mortar's entities reference each other by class name, so a renamed subclass ` +
          `leaves those relations unresolvable.`,
      );
      continue;
    }

    const sameTable = dataSource.entityMetadatas.filter((meta) => {
      try {
        return meta.tableName === dataSource.getMetadata(target).tableName;
      } catch {
        return false;
      }
    });

    if (sameTable.length > 1) {
      problems.push(
        `${sameTable.length} entities map the table '${sameTable[0]?.tableName}' ` +
          `(${sameTable.map((m) => m.name).join(', ')}). Register either your subclass ` +
          `or mortar's default, never both.`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(`Auth entity registration is invalid:\n  • ${problems.join('\n  • ')}`);
  }
}
