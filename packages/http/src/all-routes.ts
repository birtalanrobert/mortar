import nestCore from '@nestjs/core/package.json';

/**
 * The path that gives a middleware every route, in the syntax of the Nest the
 * application runs on — for `consumer.apply(…).forRoutes(allRoutes())`.
 *
 * Nest 11's router (path-to-regexp 8) names its wildcards. Handed `*`
 * beneath a global prefix it rewrites `/api/*` itself and warns at every
 * start that the route is written the old way, a warning nobody reading it
 * can act on, in every service that sets a prefix. Nest 10's reads `*` as it
 * always did, and would match nothing with `{*path}`.
 *
 * The leading slash keeps the path a wildcard to Nest, so the routes kept out
 * of the global prefix — the health probes — are given the middleware as well,
 * as they are given it by `*`.
 */
export function allRoutes(): string {
  return Number(nestCore.version.split('.')[0]) >= 11 ? '/{*path}' : '*';
}
