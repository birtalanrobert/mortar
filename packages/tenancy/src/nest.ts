import {
  CanActivate,
  ExecutionContext,
  Global,
  Inject,
  Injectable,
  Module,
  SetMetadata,
  type DynamicModule,
  type MiddlewareConsumer,
  type NestMiddleware,
  type NestModule,
  type Provider,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { getTenantId, setContextValues } from '@mortar/context';
import { MORTAR_DATA_SOURCE } from '@mortar/database';
import { ForbiddenError } from '@mortar/http';
import type { DataSource, EntityTarget } from 'typeorm';
import { resolveTenant, type ResolvableRequest, type TenantResolver } from './resolve';
import { TenantScopedRepository, type TenantOwned } from './repository';
import { runInTenantTransaction } from './rls';

export const TENANT_RESOLVERS = Symbol('MORTAR_TENANT_RESOLVERS');

/** Marks a route as usable without a tenant — signup, health, platform admin. */
export const ALLOW_NO_TENANT = 'mortar:allowNoTenant';
export const AllowNoTenant = () => SetMetadata(ALLOW_NO_TENANT, true);

/**
 * Resolves the tenant and binds it to the request context.
 *
 * Runs as middleware rather than a guard so that the tenant is present for
 * logging and auditing even on requests that are later rejected — a blocked
 * cross-tenant attempt is precisely the one whose tenant you want recorded.
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(private readonly resolvers: readonly TenantResolver[]) {}

  async use(request: ResolvableRequest, _response: unknown, next: () => void): Promise<void> {
    const resolution = await resolveTenant(this.resolvers, request);
    if (resolution) setContextValues({ tenantId: resolution.tenantId });
    next();
  }
}

/**
 * Rejects requests that reached a tenant-scoped route without a tenant.
 *
 * Fails closed: a route is protected unless it opts out with `@AllowNoTenant()`.
 * The opposite default would mean a forgotten decorator silently exposes data,
 * and defaults in a security boundary should fail the safe way.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const allowed = this.reflector.getAllAndOverride<boolean | undefined>(ALLOW_NO_TENANT, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (allowed) return true;

    if (!getTenantId()) {
      throw new ForbiddenError('This request could not be associated with a tenant.', {
        meta: { code: 'tenant_unresolved' },
      });
    }
    return true;
  }
}

/** Creates tenant-scoped repositories and tenant-bound transactions. */
export class TenantService {
  constructor(private readonly dataSource: DataSource) {}

  /** The current tenant, or undefined outside a tenant-scoped request. */
  get tenantId(): string | undefined {
    return getTenantId();
  }

  repository<Entity extends TenantOwned>(
    entity: EntityTarget<Entity>,
  ): TenantScopedRepository<Entity> {
    return new TenantScopedRepository(this.dataSource, entity);
  }

  /** Runs work in a transaction with the tenant bound for row-level security. */
  transaction<T>(
    work: Parameters<typeof runInTenantTransaction>[1],
    options?: Parameters<typeof runInTenantTransaction>[2],
  ): Promise<T> {
    return runInTenantTransaction(this.dataSource, work, options) as Promise<T>;
  }
}

export interface TenancyModuleOptions {
  /**
   * Tried in order; first match wins. Most-specific first, because a request
   * can legitimately satisfy two strategies at once.
   */
  resolvers: TenantResolver[];
}

@Global()
@Module({})
export class TenancyModule implements NestModule {
  private static resolvers: readonly TenantResolver[] = [];

  static forRoot(options: TenancyModuleOptions): DynamicModule {
    TenancyModule.resolvers = options.resolvers;

    const providers: Provider[] = [
      { provide: TENANT_RESOLVERS, useValue: options.resolvers },
      {
        provide: TenantService,
        useFactory: (dataSource: DataSource) => new TenantService(dataSource),
        inject: [MORTAR_DATA_SOURCE],
      },
      TenantGuard,
    ];

    return {
      module: TenancyModule,
      providers,
      exports: [TenantService, TenantGuard, TENANT_RESOLVERS],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(
        (request: never, response: never, next: () => void) =>
          void new TenantMiddleware(TenancyModule.resolvers).use(request, response, next),
      )
      .forRoutes('*');
  }
}

/** Injects a tenant-scoped repository for an entity. */
export const InjectTenantRepository = (entity: EntityTarget<TenantOwned>) =>
  Inject(tenantRepositoryToken(entity));

export function tenantRepositoryToken(entity: EntityTarget<TenantOwned>): string {
  const name = typeof entity === 'function' ? entity.name : String(entity);
  return `MORTAR_TENANT_REPOSITORY_${name}`;
}

/** Provider factory for a tenant-scoped repository. */
export function provideTenantRepository(entity: EntityTarget<TenantOwned>): Provider {
  return {
    provide: tenantRepositoryToken(entity),
    useFactory: (dataSource: DataSource) => new TenantScopedRepository(dataSource, entity),
    inject: [MORTAR_DATA_SOURCE],
  };
}
