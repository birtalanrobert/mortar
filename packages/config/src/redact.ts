/**
 * Substrings that mark a configuration key as secret.
 *
 * Matching is on the key name rather than the value, because a value that
 * merely looks harmless today ("dev") can become a real credential tomorrow
 * without anyone updating a list.
 */
const SECRET_PATTERNS = [
  'secret',
  'password',
  'passwd',
  'token',
  'apikey',
  'api_key',
  'privatekey',
  'private_key',
  'credential',
  'auth',
  'signature',
  'salt',
  'pepper',
  'dsn',
  'connectionstring',
  'connection_string',
];

/** Whether a configuration key should be treated as a secret. */
export function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-\s]/g, '_');
  return SECRET_PATTERNS.some((pattern) => normalized.includes(pattern));
}

/**
 * Redacts a single value, keeping a short prefix so a human can tell two
 * different secrets apart in a log without learning either.
 */
export function redactValue(value: unknown): string {
  if (value === undefined || value === null) return '<unset>';
  const text = String(value);
  if (text.length === 0) return '<empty>';
  if (text.length <= 8) return '***';
  return `${text.slice(0, 4)}***${text.slice(-2)} (${text.length} chars)`;
}

/**
 * Produces a log-safe copy of a configuration object.
 *
 * Used by the boot banner, by error reporting and by the health endpoint's
 * diagnostic mode. Nested objects are walked; keys are matched at every level.
 */
export function redactConfig<T extends Record<string, unknown>>(
  config: T,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (isSecretKey(key)) {
      result[key] = redactValue(value);
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = redactConfig(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Redacts secret values found anywhere in a URL — most importantly the
 * password in a Postgres or Redis connection string, which otherwise lands in
 * logs in full every time a connection fails.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '<invalid url>';
  }
}
