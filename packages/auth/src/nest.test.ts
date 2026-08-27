import { describe, expect, it } from 'vitest';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenError, UnauthenticatedError } from '@birtalanrobert/http';
import { HealthController } from '@birtalanrobert/http/nestjs';
import { runInContext } from '@birtalanrobert/context';
import { PermissionsGuard, Public, RequireAnyPermission, RequirePermissions } from './nest';

/** A context standing in for one route, with the class and handler it targets. */
function contextFor(target: object, handler: () => void = () => {}): ExecutionContext {
  return {
    getType: () => 'http',
    getClass: () => target as never,
    getHandler: () => handler as never,
    switchToHttp: () => ({ getRequest: () => ({}) }),
  } as unknown as ExecutionContext;
}

const guard = () => new PermissionsGuard(new Reflector());

const asUser = <T>(permissions: string[], work: () => T): T =>
  runInContext({ actor: { id: 'u1', type: 'user', roles: permissions } }, work);

describe('PermissionsGuard', () => {
  it('rejects an anonymous request to a protected route', () => {
    class Protected {}
    expect(() => guard().canActivate(contextFor(Protected))).toThrow(UnauthenticatedError);
  });

  it('allows an anonymous request to a route marked public', () => {
    class Anonymous {}
    Public()(Anonymous);
    expect(guard().canActivate(contextFor(Anonymous))).toBe(true);
  });

  /**
   * The cross-package case, and the reason the metadata key lives in
   * `@birtalanrobert/http` rather than here.
   *
   * The health controller ships from a package that cannot depend on this one,
   * yet this guard — registered globally, as it is meant to be — decides
   * whether its routes are reachable. If the two ever stop agreeing on the key,
   * readiness probes start returning 401 and pods never join the load
   * balancer. That failure looks like a broken deployment, not a missing
   * decorator, so it is worth a test.
   */
  it('treats the health controller as public', () => {
    expect(guard().canActivate(contextFor(HealthController))).toBe(true);
  });

  it('allows an authenticated request to a route requiring nothing', () => {
    class Any {}
    expect(asUser([], () => guard().canActivate(contextFor(Any)))).toBe(true);
  });

  it('requires every permission when several are declared', () => {
    class Both {}
    RequirePermissions('widgets:read', 'widgets:write')(Both);

    expect(asUser(['widgets:read', 'widgets:write'], () => guard().canActivate(contextFor(Both))));
    expect(() => asUser(['widgets:read'], () => guard().canActivate(contextFor(Both)))).toThrow(
      ForbiddenError,
    );
  });

  it('requires only one when declared with RequireAnyPermission', () => {
    class Either {}
    RequireAnyPermission('widgets:write', 'widgets:delete')(Either);

    expect(asUser(['widgets:delete'], () => guard().canActivate(contextFor(Either)))).toBe(true);
    expect(() => asUser(['widgets:read'], () => guard().canActivate(contextFor(Either)))).toThrow(
      ForbiddenError,
    );
  });

  it('honours the resource wildcard', () => {
    class Write {}
    RequirePermissions('widgets:write')(Write);
    expect(asUser(['widgets:*'], () => guard().canActivate(contextFor(Write)))).toBe(true);
  });
});
