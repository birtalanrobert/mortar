import { MortarError, UnauthenticatedError } from '@birtalanrobert/http';

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

/**
 * A second factor's code that is wrong, already used, or none at all. One
 * error for all of them: which of them it was is no business of whoever is
 * guessing.
 */
export class SecondFactorInvalidError extends MortarError {
  constructor(readonly attemptsLeft: number) {
    super(401, 'second_factor_invalid', 'Invalid code', {
      detail: 'That code is not right, or has been used already. Try the next one.',
      meta: { attemptsLeft },
    });
  }
}

/** Too many wrong codes: none is checked until `until`. */
export class SecondFactorLockedError extends MortarError {
  constructor(readonly until: Date) {
    super(423, 'second_factor_locked', 'Second factor locked', {
      detail: 'Too many wrong codes. Try again later.',
      meta: { until: until.toISOString() },
    });
  }
}

/** A code asked of an account with no second factor confirmed — or confirmed, of one with none begun. */
export class SecondFactorNotEnrolledError extends MortarError {
  constructor() {
    super(409, 'second_factor_not_enrolled', 'No second factor', {
      detail: 'This account has no second factor to check a code against.',
    });
  }
}

/** An enrolment begun for an account whose second factor is confirmed already. */
export class SecondFactorEnrolledError extends MortarError {
  constructor() {
    super(409, 'second_factor_enrolled', 'Second factor already set up', {
      detail: 'This account has a second factor already; remove it before setting up another.',
    });
  }
}
