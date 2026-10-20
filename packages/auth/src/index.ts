export {
  MAX_PASSWORD_LENGTH,
  Pbkdf2Hasher,
  ScryptHasher,
  defaultPasswordHasher,
  type PasswordHasher,
  type Pbkdf2Options,
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
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  TOTP_SECRET_BYTES,
  base32Decode,
  base32Encode,
  generateTotpSecret,
  matchTotpStep,
  otpauthUri,
  totpCode,
  totpStep,
} from './totp';
export {
  RECOVERY_CODE_COUNT,
  generateRecoveryCodes,
  hashRecoveryCode,
  looksLikeRecoveryCode,
  normaliseRecoveryCode,
} from './recovery-codes';

export {
  AccountLockedError,
  AccountSuspendedError,
  EmailAlreadyRegisteredError,
  EmailNotVerifiedError,
  InvalidCredentialsError,
  InvalidTokenError,
  SecondFactorEnrolledError,
  SecondFactorInvalidError,
  SecondFactorLockedError,
  SecondFactorNotEnrolledError,
  SessionExpiredError,
} from './errors';

export { BaseUser, User, type UserStatus } from './entities/user';
export { BaseMembership, Membership, type MembershipStatus } from './entities/membership';
export { BaseRole, Role } from './entities/role';
export { BaseMembershipRole, MembershipRole } from './entities/membership-role';
export { BaseSession, Session } from './entities/session';
export { BaseAuthToken, AuthToken, type AuthTokenType } from './entities/auth-token';
export { BaseSecondFactor, SecondFactor } from './entities/second-factor';

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
  SecondFactorService,
  type SecondFactorCheck,
  type SecondFactorEnrolment,
  type SecondFactorOptions,
  type SecondFactorStatus,
} from './services/second-factor.service';
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
  SecondFactorModule,
  type AuthModuleOptions,
} from './nest';

export { CreateAuthTables1787657643328 } from './migrations/1787657643328-CreateAuthTables';
export { AddSecondFactor1792524889184 } from './migrations/1792524889184-AddSecondFactor';

import { CreateAuthTables1787657643328 } from './migrations/1787657643328-CreateAuthTables';
import { AddSecondFactor1792524889184 } from './migrations/1792524889184-AddSecondFactor';
/** Register alongside the project's own migrations. */
export const authMigrations = [CreateAuthTables1787657643328, AddSecondFactor1792524889184];

import { User } from './entities/user';
import { Membership } from './entities/membership';
import { Role } from './entities/role';
import { MembershipRole } from './entities/membership-role';
import { Session } from './entities/session';
import { AuthToken } from './entities/auth-token';
import { SecondFactor } from './entities/second-factor';
/** Register with the DataSource. */
export const authEntities = [
  User,
  Membership,
  Role,
  MembershipRole,
  Session,
  AuthToken,
  SecondFactor,
];
