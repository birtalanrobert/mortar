/**
 * How the tenant is determined for an incoming request.
 *
 * Every project in the catalogue is multi-tenant, and each reaches its tenant
 * differently: a venue by subdomain, a distributor's buyer by session, a
 * scanner device by API key. Resolution is therefore a strategy rather than a
 * fixed rule.
 */
export interface TenantResolution {
  tenantId: string;
  /** Which strategy produced it, for logging and for diagnosing surprises. */
  source: string;
}

export interface TenantResolver {
  readonly name: string;
  resolve(request: ResolvableRequest): Promise<string | undefined> | string | undefined;
}

export interface ResolvableRequest {
  headers?: Record<string, string | string[] | undefined>;
  hostname?: string;
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  user?: { tenantId?: string } | undefined;
  session?: { tenantId?: string } | undefined;
}

function header(request: ResolvableRequest, name: string): string | undefined {
  const value = request.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Reads the tenant from a subdomain, e.g. `clubname.seatscope.app`.
 *
 * `excluded` exists because the apex, `www`, and operational hostnames are not
 * tenants — and treating `www` as a tenant slug produces a confusing 404
 * rather than an honest "no tenant here".
 */
export function subdomainResolver(options: {
  baseDomain: string;
  excluded?: readonly string[];
  /** Maps a slug to a tenant id. Usually a cached database lookup. */
  lookup: (slug: string) => Promise<string | undefined> | string | undefined;
}): TenantResolver {
  const excluded = new Set([...(options.excluded ?? ['www', 'app', 'api', 'admin'])]);
  const suffix = `.${options.baseDomain.replace(/^\./, '')}`;

  return {
    name: 'subdomain',
    async resolve(request) {
      const hostname = (request.hostname ?? header(request, 'host') ?? '')
        .split(':')[0]
        ?.toLowerCase();
      if (!hostname || !hostname.endsWith(suffix)) return undefined;

      const slug = hostname.slice(0, -suffix.length);
      if (!slug || slug.includes('.') || excluded.has(slug)) return undefined;

      return options.lookup(slug);
    },
  };
}

/** Reads the tenant from the authenticated session or user. */
export function sessionResolver(): TenantResolver {
  return {
    name: 'session',
    resolve: (request) => request.user?.tenantId ?? request.session?.tenantId,
  };
}

/**
 * Reads the tenant from an explicit header.
 *
 * **Only safe when the header is set by something trusted** — an API key
 * lookup, a gateway, an internal service. Accepting a tenant id straight from
 * a browser request is a horizontal privilege escalation, so `verify` is
 * mandatory rather than optional: the caller must prove the actor may use it.
 */
export function headerResolver(options: {
  header?: string;
  verify: (tenantId: string, request: ResolvableRequest) => Promise<boolean> | boolean;
}): TenantResolver {
  const name = options.header ?? 'x-tenant-id';
  return {
    name: 'header',
    async resolve(request) {
      const value = header(request, name);
      if (!value) return undefined;
      return (await options.verify(value, request)) ? value : undefined;
    },
  };
}

/** Reads the tenant from a route parameter, e.g. `/tenants/:tenantId/...`. */
export function pathResolver(options: {
  param?: string;
  verify: (tenantId: string, request: ResolvableRequest) => Promise<boolean> | boolean;
}): TenantResolver {
  const param = options.param ?? 'tenantId';
  return {
    name: 'path',
    async resolve(request) {
      const value = request.params?.[param];
      if (!value) return undefined;
      return (await options.verify(value, request)) ? value : undefined;
    },
  };
}

/**
 * Tries each resolver in order and returns the first match.
 *
 * Order is significant and should run most-specific first, because a request
 * can legitimately satisfy two strategies at once — a logged-in operator
 * visiting a tenant's subdomain has both a session tenant and a subdomain
 * tenant, and which one wins must be a decision rather than an accident.
 */
export async function resolveTenant(
  resolvers: readonly TenantResolver[],
  request: ResolvableRequest,
): Promise<TenantResolution | undefined> {
  for (const resolver of resolvers) {
    const tenantId = await resolver.resolve(request);
    if (tenantId) return { tenantId, source: resolver.name };
  }
  return undefined;
}
