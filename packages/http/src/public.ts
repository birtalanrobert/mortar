import { SetMetadata } from '@nestjs/common';

/**
 * Marks a route as reachable without authentication.
 *
 * The key lives in this package rather than in `@birtalanrobert/auth` because
 * this is the package that owns the HTTP surface, and it ships routes of its
 * own — the health probes — that must be reachable by an orchestrator holding
 * no credentials. `auth` cannot mark them, since nothing may depend on it: an
 * application is free to use this package with no authentication at all.
 *
 * `@birtalanrobert/auth` re-exports both of these under its own names, so a
 * consumer keeps importing `Public` from where they already do.
 */
export const PUBLIC_ROUTE_KEY = 'mortar:public';

/** Exempts a route, or a whole controller, from authentication. */
export const PublicRoute = (): MethodDecorator & ClassDecorator =>
  SetMetadata(PUBLIC_ROUTE_KEY, true);
