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
 * that are credentials: a query parameter named as one, and, given the route's
 * parameters, a path segment holding one. A share link's token is as often a
 * segment of the path (`/reports/shared/:token`) as a parameter of the query,
 * and a framework hands the logger the URL with the segment filled in.
 *
 * Deliberately string-in, string-out and tolerant of a malformed URL: this runs
 * on the logging path of every request, and a logger that throws is worse than
 * one that logs a little too much.
 */
export function safeUrl(
  url: string | undefined,
  params?: Readonly<Record<string, unknown>>,
): string | undefined {
  if (!url) return url;

  const split = url.indexOf('?');
  const path = split === -1 ? url : url.slice(0, split);
  const safePath = withoutCredentialSegments(path, params);
  if (split === -1) return safePath;

  const cleaned = url
    .slice(split + 1)
    .split('&')
    .map((pair) => {
      const equals = pair.indexOf('=');
      if (equals === -1) return pair;

      const name = pair.slice(0, equals);
      return isCredentialName(decoded(name)) ? `${name}=${REDACTED}` : pair;
    })
    .join('&');

  return `${safePath}?${cleaned}`;
}

/** Whether a parameter's name — of the query or the route — is one a credential travels under. */
function isCredentialName(name: string): boolean {
  return CREDENTIAL_PARAMETERS.has(name.toLowerCase());
}

/**
 * A path with every segment that holds the value of a credential-named route
 * parameter replaced. Compared decoded, as the framework decoded the
 * parameter; a parameter that is not a string — or not a credential — is left
 * alone.
 */
function withoutCredentialSegments(
  path: string,
  params: Readonly<Record<string, unknown>> | undefined,
): string {
  if (!params) return path;
  const secrets = new Set(
    Object.entries(params)
      .filter(([name, value]) => isCredentialName(name) && typeof value === 'string' && value)
      .map(([, value]) => value as string),
  );
  if (secrets.size === 0) return path;
  return path
    .split('/')
    .map((segment) => (secrets.has(decoded(segment)) ? REDACTED : segment))
    .join('/');
}

/** A URL component decoded, or as it is when it cannot be: a malformed one is logged, never thrown on. */
function decoded(component: string): string {
  try {
    return decodeURIComponent(component);
  } catch {
    return component;
  }
}
