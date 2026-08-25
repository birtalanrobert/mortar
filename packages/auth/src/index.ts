export {
  MAX_PASSWORD_LENGTH,
  ScryptHasher,
  defaultPasswordHasher,
  type PasswordHasher,
  type ScryptOptions,
} from './password';

export {
  generateNumericCode,
  generateToken,
  hashToken,
  issueToken,
  verifyToken,
  type IssuedToken,
} from './tokens';

export { isPlausibleEmail, normaliseEmail } from './email';

export {
  AccountLockedError,
  AccountSuspendedError,
  EmailAlreadyRegisteredError,
  EmailNotVerifiedError,
  InvalidCredentialsError,
  InvalidTokenError,
  SessionExpiredError,
} from './errors';

export { BaseUser, User, type UserStatus } from './entities/user';
export { BaseMembership, Membership, type MembershipStatus } from './entities/membership';
export { BaseRole, Role } from './entities/role';
export { BaseMembershipRole, MembershipRole } from './entities/membership-role';
export { BaseSession, Session } from './entities/session';
export { BaseAuthToken, AuthToken, type AuthTokenType } from './entities/auth-token';

export {
  UserService,
  type CreateUserInput,
  type UserServiceOptions,
} from './services/user.service';
export {
  SessionService,
  type CreatedSession,
  type SessionOptions,
} from './services/session.service';
export { RoleService, type RoleDefinition, type RoleServiceOptions } from './services/role.service';
export {
  assertAuthEntitiesValid,
  defaultAuthEntityRegistry,
  resolveRegistry,
  type AuthEntityRegistry,
} from './registry';
export {
  DEFAULT_TTL,
  TokenService,
  type IssueTokenInput,
  type IssuedAuthToken,
  type TokenServiceOptions,
} from './services/token.service';

export {
  ALL_PERMISSIONS,
  hasAllPermissions,
  hasAnyPermission,
  hasPermission,
  permissionsForRoles,
  type Permission,
  type RolePermissions,
} from './rbac';

export {
  AuthModule,
  PERMISSIONS_KEY,
  PUBLIC_KEY,
  PermissionsGuard,
  Public,
  RequireAnyPermission,
  RequirePermissions,
  type AuthModuleOptions,
} from './nest';

export { CreateAuthTables1787657643328 } from './migrations/1787657643328-CreateAuthTables';

import { CreateAuthTables1787657643328 } from './migrations/1787657643328-CreateAuthTables';
/** Register alongside the project's own migrations. */
export const authMigrations = [CreateAuthTables1787657643328];

import { User } from './entities/user';
import { Membership } from './entities/membership';
import { Role } from './entities/role';
import { MembershipRole } from './entities/membership-role';
import { Session } from './entities/session';
import { AuthToken } from './entities/auth-token';
/** Register with the DataSource. */
export const authEntities = [User, Membership, Role, MembershipRole, Session, AuthToken];
