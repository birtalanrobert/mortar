import { ValidationError } from '@birtalanrobert/http';

export interface KeyParts {
  tenantId: string;
  /** What the file belongs to, as `type/id` — `request/9f2a…`, `invoice/117`. */
  scope: string;
  /** The stored file's own id. Never the client's filename. */
  fileId: string;
  /** Lowercased, from the detected type. Absent when the type is unknown. */
  extension?: string;
}

/**
 * Where a file lives in the bucket.
 *
 * One bucket for every tenant, with the tenant's id as the first path segment,
 * because that is what makes a bucket policy expressible: a role scoped to
 * `tenants/<id>/*` cannot name another tenant's object no matter what key it is
 * handed. A bucket per tenant would give the same isolation and then run into
 * the account's bucket limit somewhere in the low hundreds of customers.
 *
 * The key is built from ids we generated, never from anything a client sent. A
 * filename is data, and data in a path is how `../` and a null byte become
 * somebody else's object.
 */
export function objectKey(parts: KeyParts): string {
  assertSegment(parts.tenantId, 'tenant id');
  assertSegment(parts.fileId, 'file id');
  assertScope(parts.scope);

  const extension = parts.extension ? `.${normaliseExtension(parts.extension)}` : '';
  return `tenants/${parts.tenantId}/${parts.scope}/${parts.fileId}${extension}`;
}

/**
 * The tenant a key belongs to, or nothing if it is not a key we would have
 * written.
 *
 * Parsing rather than trusting: a key arrives from a database row, and a row is
 * only as trustworthy as everything that has ever written to it.
 */
export function tenantOf(key: string): string | undefined {
  const match = /^tenants\/([^/]+)\//.exec(key);
  return match?.[1];
}

/**
 * Refuses a key that does not belong to this tenant.
 *
 * The last check before an object is fetched, deleted or signed for. Row-level
 * security governs the database; nothing governs the bucket except the key we
 * hand it, so the equivalent check has to be made explicitly and at the point
 * of use.
 */
export function assertTenantOwns(tenantId: string, key: string): void {
  if (tenantOf(key) !== tenantId) {
    throw new ValidationError([
      { field: 'key', message: 'That file does not belong to this tenant.', code: 'cross_tenant' },
    ]);
  }
}

/**
 * A filename safe to offer a browser, derived from what the client called it.
 *
 * Used only in `Content-Disposition`, never in a key. Keeps the shape of the
 * original — a client who uploaded `Extras cont ianuarie.pdf` should get
 * something they recognise back — while removing everything that changes the
 * meaning of a path or of the header it sits in.
 */
export function safeFilename(filename: string, fallback = 'document'): string {
  const cleaned = filename
    .normalize('NFKC')
    // Path separators first, so what they contained survives as a name.
    .replace(/[/\\]/g, '_')
    // Control characters and the quote that would end the header's own quoted
    // string. A header is parsed by software that has no idea a filename is
    // untrusted.
    //
    // `no-control-regex` exists to catch these arriving by accident. Here they
    // are the point: a newline in a filename is header injection, and matching
    // them is what stops it.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"]/g, '')
    .replace(/^\.+/, '')
    .trim();

  return cleaned.slice(0, 120) || fallback;
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function assertSegment(value: string, what: string): void {
  if (!SEGMENT.test(value)) {
    throw new ValidationError([
      { field: what, message: `A ${what} must be an id, not a path.`, code: 'invalid_key_part' },
    ]);
  }
}

function assertScope(scope: string): void {
  const segments = scope.split('/');
  if (segments.length < 1 || segments.length > 3) {
    throw new ValidationError([
      { field: 'scope', message: 'A scope is one to three path segments.', code: 'invalid_scope' },
    ]);
  }
  for (const segment of segments) assertSegment(segment, 'scope segment');
}

function normaliseExtension(extension: string): string {
  const cleaned = extension.toLowerCase().replace(/^\./, '');
  if (!/^[a-z0-9]{1,12}$/.test(cleaned)) {
    throw new ValidationError([
      { field: 'extension', message: 'That is not a file extension.', code: 'invalid_extension' },
    ]);
  }
  return cleaned;
}
