import { MortarError, UnauthenticatedError } from '@mortar/http';

/**
 * Wrong email, wrong password, unknown account — all the same error.
 *
 * Never distinguish them. A different message or a different response time for
 * "no such user" turns the login form into an account-enumeration oracle, and
 * the enumerated list is exactly what a credential-stuffing run needs.
 */
export class InvalidCredentialsError extends UnauthenticatedError {
  constructor() {
    super('The email address or password is incorrect.');
  }
}

/** The account exists and is temporarily locked after repeated failures. */
export class AccountLockedError extends MortarError {
  constructor(readonly until: Date) {
    super(423, 'account_locked', 'Account temporarily locked', {
      detail: 'Too many failed sign-in attempts. Try again later.',
      meta: { until: until.toISOString() },
    });
  }
}

export class AccountSuspendedError extends MortarError {
  constructor() {
    super(403, 'account_suspended', 'Account suspended', {
      detail: 'This account has been suspended. Contact support.',
    });
  }
}

export class EmailNotVerifiedError extends MortarError {
  constructor() {
    super(403, 'email_not_verified', 'Email not verified', {
      detail: 'Verify your email address before signing in.',
    });
  }
}

/** A token that is unknown, expired, or already spent. All look alike. */
export class InvalidTokenError extends MortarError {
  constructor(detail = 'This link is invalid or has expired. Request a new one.') {
    super(400, 'invalid_token', 'Invalid or expired link', { detail });
  }
}

export class SessionExpiredError extends UnauthenticatedError {
  constructor() {
    super('Your session has expired. Please sign in again.');
  }
}

export class EmailAlreadyRegisteredError extends MortarError {
  constructor() {
    super(409, 'email_already_registered', 'Email already registered', {
      detail: 'An account with this email address already exists.',
    });
  }
}
