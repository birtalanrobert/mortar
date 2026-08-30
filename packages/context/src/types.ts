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
   * is scheduled or internal work; `service` is a machine credential;
   * `operator` is one of *us* working inside a customer's account.
   *
   * `operator` is separate from `user` because the audit trail has to be able
   * to say which it was. Support access recorded as the customer's own action
   * is worse than no record at all — it is a confident answer to "who opened
   * this?" that names the wrong person, and the customer has no way to tell.
   */
  readonly type: 'user' | 'client' | 'system' | 'service' | 'operator';
  readonly displayName?: string;
  readonly roles?: readonly string[];
  /**
   * Who is behind the action, when it is not the actor.
   *
   * For the shape where an operator acts *as* a named user, so the trail can
   * say both. Where the operator acts as themselves inside a customer's
   * account — which is the safer shape, because nothing is disguised — the
   * actor's own `type` is `operator` and this stays unset.
   */
  readonly impersonatedBy?: string;
}
