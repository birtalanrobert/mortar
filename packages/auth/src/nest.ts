import {
  CanActivate,
  ExecutionContext,
  Global,
  Injectable,
  Module,
  SetMetadata,
  type DynamicModule,
  type Provider,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AsyncModuleOptions } from '@birtalanrobert/context';
import { getActor, getTenantId } from '@birtalanrobert/context';
import { MORTAR_DATA_SOURCE } from '@birtalanrobert/database';
import { ForbiddenError, UnauthenticatedError } from '@birtalanrobert/http';
import type { DataSource } from 'typeorm';
import { hasAllPermissions, hasAnyPermission, type Permission } from './rbac';
import { SessionService, type SessionOptions } from './services/session.service';
import { TokenService } from './services/token.service';
import { RoleService } from './services/role.service';
import { assertAuthEntitiesValid, resolveRegistry, type AuthEntityRegistry } from './registry';
import { UserService, type UserServiceOptions } from './services/user.service';

export const PERMISSIONS_KEY = 'mortar:permissions';
export const PUBLIC_KEY = 'mortar:public';

/** Marks a route as reachable without authentication. */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/** Requires every listed permission. */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, { permissions, mode: 'all' as const });

/** Requires at least one of the listed permissions. */
export const RequireAnyPermission = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, { permissions, mode: 'any' as const });

/**
 * Enforces authentication and permissions.
 *
 * Fails closed: a route is protected unless it opts out with `@Public()`. The
 * opposite default means one forgotten decorator silently exposes an endpoint,
 * and a security default should fail the safe way.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const actor = getActor();
    if (!actor) throw new UnauthenticatedError();

    const required = this.reflector.getAllAndOverride<
      { permissions: Permission[]; mode: 'all' | 'any' } | undefined
    >(PERMISSIONS_KEY, [context.getHandler(), context.getClass()]);

    if (!required || required.permissions.length === 0) return true;

    const granted = new Set(actor.roles ?? []);
    const satisfied =
      required.mode === 'any'
        ? hasAnyPermission(granted, required.permissions)
        : hasAllPermissions(granted, required.permissions);

    if (!satisfied) {
      throw new ForbiddenError('You do not have permission to perform this action.', {
        meta: { required: required.permissions, tenantId: getTenantId() },
      });
    }
    return true;
  }
}

export interface AuthModuleOptions {
  user?: UserServiceOptions;
  session?: SessionOptions;
  /**
   * Entity subclasses this project registered, if it extended the bases.
   *
   * Validated at module construction, so a renamed subclass or a
   * double-registered table is reported at boot rather than surfacing as an
   * obscure metadata error later.
   */
  entities?: Partial<AuthEntityRegistry>;
}

@Global()
@Module({})
export class AuthModule {
  static forRoot(options: AuthModuleOptions = {}): DynamicModule {
    const entities = options.entities;

    const providers: Provider[] = [
      {
        provide: RoleService,
        useFactory: (dataSource: DataSource) => {
          assertAuthEntitiesValid(dataSource, resolveRegistry(entities));
          return new RoleService(dataSource, { entities });
        },
        inject: [MORTAR_DATA_SOURCE],
      },
      {
        provide: UserService,
        useFactory: (dataSource: DataSource, roleService: RoleService) =>
          new UserService(dataSource, { ...options.user, entities, roleService }),
        inject: [MORTAR_DATA_SOURCE, RoleService],
      },
      {
        provide: SessionService,
        useFactory: (dataSource: DataSource) =>
          new SessionService(dataSource, { ...options.session, entities }),
        inject: [MORTAR_DATA_SOURCE],
      },
      {
        provide: TokenService,
        useFactory: (dataSource: DataSource) => new TokenService(dataSource, { entities }),
        inject: [MORTAR_DATA_SOURCE],
      },
      PermissionsGuard,
    ];

    return {
      module: AuthModule,
      providers,
      exports: [UserService, RoleService, SessionService, TokenService, PermissionsGuard],
    };
  }

  /** Configures from other providers — validated config, most often. */
  static forRootAsync(options: AsyncModuleOptions<AuthModuleOptions>): DynamicModule {
    const providers: Provider[] = [
      {
        provide: RoleService,
        useFactory: async (dataSource: DataSource, ...args: never[]) => {
          const resolved = await options.useFactory(...args);
          assertAuthEntitiesValid(dataSource, resolveRegistry(resolved.entities));
          return new RoleService(dataSource, { entities: resolved.entities });
        },
        inject: [MORTAR_DATA_SOURCE, ...((options.inject ?? []) as never[])],
      },
      {
        provide: UserService,
        useFactory: async (dataSource: DataSource, roleService: RoleService, ...args: never[]) => {
          const resolved = await options.useFactory(...args);
          return new UserService(dataSource, {
            ...resolved.user,
            entities: resolved.entities,
            roleService,
          });
        },
        inject: [MORTAR_DATA_SOURCE, RoleService, ...((options.inject ?? []) as never[])],
      },
      {
        provide: SessionService,
        useFactory: async (dataSource: DataSource, ...args: never[]) => {
          const resolved = await options.useFactory(...args);
          return new SessionService(dataSource, {
            ...resolved.session,
            entities: resolved.entities,
          });
        },
        inject: [MORTAR_DATA_SOURCE, ...((options.inject ?? []) as never[])],
      },
      {
        provide: TokenService,
        useFactory: async (dataSource: DataSource, ...args: never[]) => {
          const resolved = await options.useFactory(...args);
          return new TokenService(dataSource, { entities: resolved.entities });
        },
        inject: [MORTAR_DATA_SOURCE, ...((options.inject ?? []) as never[])],
      },
      PermissionsGuard,
    ];

    return {
      module: AuthModule,
      imports: (options.imports ?? []) as never[],
      providers,
      exports: [UserService, RoleService, SessionService, TokenService, PermissionsGuard],
    };
  }
}
