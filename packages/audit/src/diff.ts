/** Field names whose values are replaced with a marker before storage. */
const DEFAULT_REDACTED = [
  'password',
  'passwordhash',
  'token',
  'accesstoken',
  'refreshtoken',
  'secret',
  'apikey',
  'privatekey',
  'pin',
  'cvv',
  'cardnumber',
  'iban',
  'ssn',
  'nationalid',
];

export const REDACTED = '[redacted]';

export interface DiffOptions {
  /** Extra field names to redact, in addition to the defaults. */
  redact?: readonly string[];
  /** Fields to leave out of the diff entirely, e.g. `updatedAt`. */
  ignore?: readonly string[];
}

export type Changes = Record<string, { from: unknown; to: unknown }>;

/**
 * Computes what actually changed between two versions of a record.
 *
 * Only changed fields are stored, for three reasons: the log stays small
 * enough to keep for years, a reader can see at a glance what happened without
 * diffing two blobs by eye, and unchanged personal data is not copied into a
 * second table where it would have to be found again at erasure time.
 */
export function computeChanges(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  options: DiffOptions = {},
): Changes | null {
  const redact = new Set(
    [...DEFAULT_REDACTED, ...(options.redact ?? [])].map((field) => normalize(field)),
  );
  const ignore = new Set((options.ignore ?? []).map((field) => normalize(field)));

  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const changes: Changes = {};

  for (const key of keys) {
    if (ignore.has(normalize(key))) continue;

    const from = before?.[key];
    const to = after?.[key];
    if (isEqual(from, to)) continue;

    changes[key] = redact.has(normalize(key))
      ? {
          from: from === undefined ? undefined : REDACTED,
          to: to === undefined ? undefined : REDACTED,
        }
      : { from, to };
  }

  return Object.keys(changes).length > 0 ? changes : null;
}

/** Redacts sensitive keys anywhere in a metadata object, including nested. */
export function redactMetadata(
  metadata: Record<string, unknown>,
  extra: readonly string[] = [],
): Record<string, unknown> {
  const redact = new Set([...DEFAULT_REDACTED, ...extra].map(normalize));
  const walk = (value: unknown, depth: number): unknown => {
    if (depth > 8 || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1));
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      result[key] = redact.has(normalize(key)) ? REDACTED : walk(nested, depth + 1);
    }
    return result;
  };
  return walk(metadata, 0) as Record<string, unknown>;
}

function normalize(field: string): string {
  return field.toLowerCase().replace(/[_\-\s]/g, '');
}

/**
 * Value equality for audit purposes.
 *
 * Dates compare by instant, not identity — a record re-read from the database
 * yields different Date objects for the same moment, and treating that as a
 * change would fill the log with entries where nothing happened.
 */
function isEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}
