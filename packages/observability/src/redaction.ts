/**
 * Field paths redacted from every log line.
 *
 * Logs are the most common accidental disclosure route in a web application:
 * a request body logged wholesale on error is how card details, passwords and
 * identity documents end up in a log aggregator that a wider group can read.
 * The default list is deliberately broad — over-redaction costs a debugging
 * session, under-redaction costs a breach notification.
 */
export const DEFAULT_REDACTED_PATHS: readonly string[] = [
  'password',
  'passwordHash',
  'currentPassword',
  'newPassword',
  'passwordConfirmation',
  'secret',
  'token',
  'accessToken',
  'refreshToken',
  'apiKey',
  'authorization',
  'cookie',
  'sessionId',
  'creditCard',
  'cardNumber',
  'cvv',
  'cvc',
  'iban',
  'pin',
  'ssn',
  'taxId',
  'nationalId',
  'dateOfBirth',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body.password',
  'res.headers["set-cookie"]',
];

/** The placeholder written in place of a redacted value. */
export const REDACTED = '[redacted]';

/**
 * Builds the wildcard path list pino needs to catch these keys at any depth.
 */
export function buildRedactionPaths(extra: readonly string[] = []): string[] {
  const keys = [...DEFAULT_REDACTED_PATHS, ...extra];
  const paths = new Set<string>();
  for (const key of keys) {
    if (key.includes('.') || key.includes('[')) {
      paths.add(key);
    } else {
      paths.add(key);
      paths.add(`*.${key}`);
      paths.add(`*.*.${key}`);
    }
  }
  return [...paths];
}
