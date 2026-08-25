import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Actor, ContextSource, RequestContext } from './types';

const storage = new AsyncLocalStorage<RequestContext>();

export interface CreateContextOptions {
  requestId?: string;
  correlationId?: string;
  tenantId?: string;
  actor?: Actor;
  locale?: string;
  ip?: string;
  userAgent?: string;
  source?: ContextSource;
}

/** Builds a context without entering it. Rarely needed directly. */
export function createContext(options: CreateContextOptions = {}): RequestContext {
  const requestId = options.requestId ?? randomUUID();
  return {
    requestId,
    correlationId: options.correlationId ?? requestId,
    tenantId: options.tenantId,
    actor: options.actor,
    locale: options.locale,
    ip: options.ip,
    userAgent: options.userAgent,
    source: options.source ?? 'internal',
    startedAt: Date.now(),
    attributes: new Map<string, unknown>(),
  };
}

/**
 * Runs `fn` inside a fresh context. Everything called from `fn`, synchronously
 * or asynchronously, sees that context.
 */
export function runInContext<T>(options: CreateContextOptions, fn: () => T): T {
  return storage.run(createContext(options), fn);
}

/** Runs `fn` inside an already-built context. */
export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The current context, or undefined outside one. */
export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * The current context, throwing if there is none.
 *
 * Use where the absence of a context is a programming error — a tenant-scoped
 * repository, for instance, must never run unscoped.
 */
export function requireContext(): RequestContext {
  const context = storage.getStore();
  if (!context) {
    throw new Error(
      'No request context is active. Wrap this work in runInContext(), or use getContext() ' +
        'if running outside a request is legitimate here.',
    );
  }
  return context;
}

/** The current tenant, or undefined. */
export function getTenantId(): string | undefined {
  return storage.getStore()?.tenantId;
}

/**
 * The current tenant, throwing if absent.
 *
 * This is a security primitive: a query that should be tenant-scoped must fail
 * loudly rather than quietly returning every tenant's rows.
 */
export function requireTenantId(): string {
  const tenantId = storage.getStore()?.tenantId;
  if (!tenantId) {
    throw new Error(
      'No tenant is bound to the current context. A tenant-scoped operation cannot proceed ' +
        'without one — this would otherwise read across tenants.',
    );
  }
  return tenantId;
}

export function getActor(): Actor | undefined {
  return storage.getStore()?.actor;
}

export function requireActor(): Actor {
  const actor = storage.getStore()?.actor;
  if (!actor) throw new Error('No actor is bound to the current context.');
  return actor;
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

export function getCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

export function getLocale(): string | undefined {
  return storage.getStore()?.locale;
}

/** Milliseconds since the current unit of work started. */
export function elapsedMs(): number | undefined {
  const context = storage.getStore();
  return context ? Date.now() - context.startedAt : undefined;
}

/**
 * Mutates the active context.
 *
 * Deliberately narrow: only the fields that are genuinely resolved *during* a
 * request — the tenant after resolution, the actor after authentication, the
 * locale after negotiation — are settable. Identity fields are immutable.
 */
export function setContextValues(
  values: Pick<RequestContext, 'tenantId' | 'actor' | 'locale'>,
): void {
  const context = storage.getStore();
  if (!context) return;
  if (values.tenantId !== undefined) context.tenantId = values.tenantId;
  if (values.actor !== undefined) context.actor = values.actor;
  if (values.locale !== undefined) context.locale = values.locale;
}

export function setAttribute(key: string, value: unknown): void {
  storage.getStore()?.attributes.set(key, value);
}

export function getAttribute<T = unknown>(key: string): T | undefined {
  return storage.getStore()?.attributes.get(key) as T | undefined;
}

/**
 * Runs `fn` in a child context inheriting correlation from the current one.
 *
 * The mechanism by which a background job spawned from a request stays
 * traceable back to it.
 */
export function runInChildContext<T>(options: CreateContextOptions, fn: () => T): T {
  const parent = storage.getStore();
  return runInContext(
    {
      correlationId: parent?.correlationId,
      tenantId: parent?.tenantId,
      actor: parent?.actor,
      locale: parent?.locale,
      ...options,
    },
    fn,
  );
}

/**
 * The fields worth attaching to every log line and propagating to a job.
 */
export function contextSnapshot(): Record<string, unknown> {
  const context = storage.getStore();
  if (!context) return {};
  return {
    requestId: context.requestId,
    correlationId: context.correlationId,
    ...(context.tenantId ? { tenantId: context.tenantId } : {}),
    ...(context.actor ? { actorId: context.actor.id, actorType: context.actor.type } : {}),
    ...(context.actor?.impersonatedBy ? { impersonatedBy: context.actor.impersonatedBy } : {}),
    source: context.source,
  };
}
