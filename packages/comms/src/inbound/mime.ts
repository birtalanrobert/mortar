import type { InboundAttachment, InboundMessage } from './message';

interface Part {
  headers: Map<string, string>;
  body: Buffer;
}

/**
 * An RFC 5322 message, parsed far enough to be useful and no further.
 *
 * Written rather than taken from a dependency for one reason: this runs on
 * every inbound message, and inbound mail is the most hostile input the system
 * accepts — anyone can send it, from anywhere, in any shape. A parser here is
 * eighty lines of code that can be read in full and tested against the cases
 * that actually arrive. A general-purpose one is a large, permanently-running
 * attack surface for a feature that needs six headers and the attachments.
 *
 * What it deliberately does not do: MIME is enormous, and the parts nobody
 * sends — message/partial, uuencode, nested digests — are left unhandled rather
 * than half-handled. An unrecognised part becomes an attachment with the bytes
 * intact, which is the failure a person can act on.
 */
export function parseMime(raw: Buffer | string): InboundMessage {
  const message = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw;
  const root = splitPart(message);

  const text: string[] = [];
  const html: string[] = [];
  const attachments: InboundAttachment[] = [];

  collect(root, text, html, attachments);

  const to = addressList(root.headers.get('to'));
  const cc = addressList(root.headers.get('cc'));

  return {
    messageId: root.headers.get('message-id')?.replace(/^<|>$/g, ''),
    from: addressList(root.headers.get('from'))[0] ?? '',
    to,
    cc,
    subject: decodeWords(root.headers.get('subject') ?? ''),
    text: text.join('\n').trim(),
    html: html.length > 0 ? html.join('\n') : undefined,
    attachments,
    receivedAt: parseDate(root.headers.get('date')),
  };
}

/**
 * Walks a part and everything inside it.
 *
 * `multipart/alternative` holds the same message twice, so both arms are kept
 * and the caller chooses; `multipart/mixed` and `related` hold different
 * things, so everything is kept. Treating them identically is simpler than the
 * distinction is worth, because the only consumer wants "the text, the HTML,
 * and every file".
 */
function collect(
  part: Part,
  text: string[],
  html: string[],
  attachments: InboundAttachment[],
  depth = 0,
): void {
  // A message can nest legitimately — a forward of a forward — but not
  // indefinitely. Twenty is far past anything real and stops a crafted message
  // from exhausting the stack.
  if (depth > 20) return;

  const contentType = part.headers.get('content-type') ?? 'text/plain';
  const mediaType = contentType.split(';')[0]?.trim().toLowerCase() ?? 'text/plain';

  if (mediaType.startsWith('multipart/')) {
    const boundary = parameter(contentType, 'boundary');
    if (!boundary) return;

    for (const child of splitMultipart(part.body, boundary)) {
      collect(splitPart(child), text, html, attachments, depth + 1);
    }
    return;
  }

  const disposition = part.headers.get('content-disposition') ?? '';
  const filename =
    parameter(disposition, 'filename') ?? parameter(contentType, 'name') ?? undefined;
  const isAttachment = /^attachment/i.test(disposition) || filename !== undefined;

  const decoded = decodeBody(part);

  if (isAttachment) {
    attachments.push({
      filename: decodeWords(filename ?? 'attachment'),
      contentType: mediaType,
      content: decoded,
      contentId: part.headers.get('content-id')?.replace(/^<|>$/g, ''),
      inline: /^inline/i.test(disposition),
    });
    return;
  }

  const charset = parameter(contentType, 'charset') ?? 'utf-8';
  const body = decodeText(decoded, charset);

  if (mediaType === 'text/html') html.push(body);
  else text.push(body);
}

/** Separates the headers from the body at the first blank line. */
function splitPart(part: Buffer): Part {
  const separator = findHeaderEnd(part);
  const headerText = part.subarray(0, separator.end).toString('utf8');
  const body = part.subarray(separator.bodyStart);

  return { headers: parseHeaders(headerText), body };
}

function findHeaderEnd(part: Buffer): { end: number; bodyStart: number } {
  const crlf = part.indexOf('\r\n\r\n');
  const lf = part.indexOf('\n\n');

  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { end: crlf, bodyStart: crlf + 4 };
  if (lf !== -1) return { end: lf, bodyStart: lf + 2 };
  // A part with headers and no body is legal and arrives from real senders.
  return { end: part.length, bodyStart: part.length };
}

/**
 * Header names lowercased, continuation lines joined.
 *
 * A header may be folded across several lines, with continuations indented —
 * which is how a long `Content-Type` with a boundary usually arrives, and how a
 * naive line-by-line parser loses the boundary and then finds no attachments.
 */
function parseHeaders(text: string): Map<string, string> {
  const headers = new Map<string, string>();
  const lines = text.split(/\r?\n/);

  let current: string | undefined;
  let value = '';

  const flush = () => {
    if (current) headers.set(current, value.trim());
  };

  for (const line of lines) {
    if (/^[ \t]/.test(line) && current) {
      value += ` ${line.trim()}`;
      continue;
    }

    const colon = line.indexOf(':');
    if (colon === -1) continue;

    flush();
    current = line.slice(0, colon).trim().toLowerCase();
    value = line.slice(colon + 1);
  }
  flush();

  return headers;
}

/** The parts between `--boundary` markers, up to `--boundary--`. */
function splitMultipart(body: Buffer, boundary: string): Buffer[] {
  const marker = Buffer.from(`--${boundary}`);
  const parts: Buffer[] = [];

  let index = body.indexOf(marker);
  if (index === -1) return parts;

  while (index !== -1) {
    const start = index + marker.length;
    // `--boundary--` closes the multipart; everything after it is epilogue.
    if (body.subarray(start, start + 2).toString('ascii') === '--') break;

    const next = body.indexOf(marker, start);
    const end = next === -1 ? body.length : next;

    // Skip the CRLF that follows the marker, and drop the one before the next.
    const partStart = skipNewline(body, start);
    parts.push(trimTrailingNewline(body.subarray(partStart, end)));

    index = next;
  }

  return parts;
}

function skipNewline(body: Buffer, index: number): number {
  if (body[index] === 0x0d && body[index + 1] === 0x0a) return index + 2;
  if (body[index] === 0x0a) return index + 1;
  return index;
}

function trimTrailingNewline(part: Buffer): Buffer {
  if (part.subarray(-2).toString('ascii') === '\r\n') return part.subarray(0, part.length - 2);
  if (part[part.length - 1] === 0x0a) return part.subarray(0, part.length - 1);
  return part;
}

function decodeBody(part: Part): Buffer {
  const encoding = (part.headers.get('content-transfer-encoding') ?? '7bit').trim().toLowerCase();

  if (encoding === 'base64') {
    // Whitespace is not part of the alphabet, and every real encoder wraps.
    return Buffer.from(part.body.toString('ascii').replace(/\s+/g, ''), 'base64');
  }
  if (encoding === 'quoted-printable') {
    return decodeQuotedPrintable(part.body.toString('ascii'));
  }
  return part.body;
}

function decodeQuotedPrintable(input: string): Buffer {
  const bytes: number[] = [];
  // A soft line break — `=` at end of line — encodes nothing at all.
  const text = input.replace(/=\r?\n/g, '');

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '=' && index + 2 < text.length) {
      const hex = text.slice(index + 1, index + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        index += 2;
        continue;
      }
    }
    bytes.push(text.charCodeAt(index) & 0xff);
  }

  return Buffer.from(bytes);
}

/**
 * Bytes to text, in the charset the part declared.
 *
 * Latin-1 and Windows-1252 still arrive from older mail clients, and reading
 * them as UTF-8 turns `Situație` into mojibake in the one place a person will
 * read it.
 */
function decodeText(content: Buffer, charset: string): string {
  const normalised = charset.toLowerCase().replace(/["']/g, '');
  try {
    return new TextDecoder(normalised, { fatal: false }).decode(content);
  } catch {
    return content.toString('utf8');
  }
}

/**
 * RFC 2047 encoded words — `=?UTF-8?B?…?=` in a header.
 *
 * Any subject or filename that is not plain ASCII arrives this way, which in
 * Romanian and Hungarian is most of them.
 */
function decodeWords(value: string): string {
  return value.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (match, charset: string, encoding: string, text: string) => {
      try {
        const bytes =
          encoding.toUpperCase() === 'B'
            ? Buffer.from(text, 'base64')
            : // In a header, `_` means a space. Everywhere else it is itself.
              decodeQuotedPrintable(text.replace(/_/g, ' '));
        return decodeText(bytes, charset);
      } catch {
        return match;
      }
    },
  );
}

/** Every address in a header, without display names. */
function addressList(value?: string): string[] {
  if (!value) return [];

  return value
    .split(',')
    .map((entry) => {
      const angled = /<([^>]+)>/.exec(entry);
      return (angled?.[1] ?? entry).trim().toLowerCase();
    })
    .filter((entry) => /^[^\s@]+@[^\s@]+$/.test(entry));
}

function parameter(header: string, name: string): string | undefined {
  const quoted = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i').exec(header);
  if (quoted?.[1] !== undefined) return quoted[1];

  const bare = new RegExp(`${name}\\s*=\\s*([^;\\s]+)`, 'i').exec(header);
  return bare?.[1];
}

/**
 * The `Date` header, falling back to now.
 *
 * A message with an unparseable or absent date is common enough not to be worth
 * refusing over, and "when we received it" is the more useful answer anyway.
 */
function parseDate(value?: string): Date {
  if (!value) return new Date();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}
