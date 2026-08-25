/**
 * The ambient facts about the work currently in flight.
 *
 * Carried through AsyncLocalStorage rather than threaded through every
 * function signature, because these values are needed by logging, auditing,
 * tenant scoping and error reporting — layers that should not force every
 * intermediate function to know about them.
 */
export interface RequestContext {
  /** Unique per inbound request or job execution. */
  readonly requestId: string;
  /**
   * Correlates work across service boundaries and background jobs. Inherited
   * from an incoming header where present, otherwise equal to requestId.
   */
  readonly correlationId: string;
  /** The tenant this work belongs to, once resolved. */
  tenantId?: string;
  /** The authenticated principal, once resolved. */
  actor?: Actor;
  /** Resolved locale, e.g. 'ro-RO'. */
  locale?: string;
  /** Client address, for audit and rate limiting. */
  ip?: string;
  /** Client user agent, for audit. */
  userAgent?: string;
  /** Where this unit of work came from. */
  readonly source: ContextSource;
  /** When the unit of work started, for duration measurement. */
  readonly startedAt: number;
  /** Free-form values attached by application code. */
  readonly attributes: Map<string, unknown>;
}

export type ContextSource = 'http' | 'job' | 'cli' | 'test' | 'internal';

export interface Actor {
  readonly id: string;
  /**
   * `user` is a human with an account; `client` is a link-authenticated party
   * with no account (a guest, a candidate, a tenant of a landlord); `system`
   * is scheduled or internal work; `service` is a machine credential.
   */
  readonly type: 'user' | 'client' | 'system' | 'service';
  readonly displayName?: string;
  readonly roles?: readonly string[];
  /** Set when an operator is impersonating; the audit trail records both. */
  readonly impersonatedBy?: string;
}
