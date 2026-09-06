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

/**
 * Query-string parameters whose *value* is a credential.
 *
 * Path-based redaction cannot help here: the URL is logged as one string under
 * a field called `url`, and a signed link's token sits inside it. Anybody who
 * can read the logs can then read, move or cancel the booking it points at —
 * and a signed link is often the *only* credential a customer without an
 * account has.
 *
 * Matched case-insensitively, and on the whole parameter name, so `token`
 * catches `token` and `access_token` catches itself without `tokenCount`
 * becoming unreadable.
 */
const CREDENTIAL_PARAMETERS = new Set([
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'code',
  'secret',
  'apikey',
  'api_key',
  'key',
  'password',
  'signature',
  'sig',
  'session',
]);

/**
 * A URL safe to write down.
 *
 * Keeps the path and every ordinary parameter — a log line with the query
 * stripped entirely is one nobody can debug from — and replaces only the values
 * that are credentials.
 *
 * Deliberately string-in, string-out and tolerant of a malformed URL: this runs
 * on the logging path of every request, and a logger that throws is worse than
 * one that logs a little too much.
 */
export function safeUrl(url: string | undefined): string | undefined {
  if (!url) return url;

  const split = url.indexOf('?');
  if (split === -1) return url;

  const path = url.slice(0, split);
  const query = url.slice(split + 1);

  const cleaned = query
    .split('&')
    .map((pair) => {
      const equals = pair.indexOf('=');
      if (equals === -1) return pair;

      const name = pair.slice(0, equals);
      return CREDENTIAL_PARAMETERS.has(decodeURIComponent(name).toLowerCase())
        ? `${name}=${REDACTED}`
        : pair;
    })
    .join('&');

  return `${path}?${cleaned}`;
}
