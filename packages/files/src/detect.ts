export interface DetectedType {
  contentType: string;
  extension: string;
}

/**
 * What a file actually is, read from its first bytes.
 *
 * A client's `Content-Type` header and a filename's extension are both claims
 * made by whoever uploaded the file. Storing either as fact means a document
 * collection product will eventually serve a professional an executable that a
 * database row insists is a PDF.
 *
 * Signatures rather than a library: the set of types this accepts is small,
 * closed and unlikely to grow — the alternative is a dependency that knows six
 * hundred formats in order to be asked about six.
 */
const SIGNATURES: Array<{
  contentType: string;
  extension: string;
  matches: (bytes: Buffer) => boolean;
}> = [
  { contentType: 'application/pdf', extension: 'pdf', matches: (b) => starts(b, '%PDF-') },
  {
    contentType: 'image/jpeg',
    extension: 'jpg',
    matches: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    contentType: 'image/png',
    extension: 'png',
    matches: (b) => bytes(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  {
    contentType: 'image/heic',
    extension: 'heic',
    // The brand sits at offset 8, after the box length and `ftyp`.
    matches: (b) =>
      b.length > 12 &&
      b.subarray(4, 8).toString('ascii') === 'ftyp' &&
      HEIC.has(b.subarray(8, 12).toString('ascii')),
  },
  {
    contentType: 'image/webp',
    extension: 'webp',
    matches: (b) =>
      b.length > 12 &&
      b.subarray(0, 4).toString('ascii') === 'RIFF' &&
      b.subarray(8, 12).toString('ascii') === 'WEBP',
  },
  {
    contentType: 'image/tiff',
    extension: 'tif',
    matches: (b) => bytes(b, [0x49, 0x49, 0x2a, 0x00]) || bytes(b, [0x4d, 0x4d, 0x00, 0x2a]),
  },
];

/** HEIC and its relatives, all of which a phone camera may produce. */
const HEIC = new Set(['heic', 'heix', 'hevc', 'heim', 'heis', 'hevm', 'mif1', 'msf1']);

/**
 * Office documents, which are ZIP archives and cannot be told apart from a
 * plain ZIP by their first bytes alone.
 *
 * Deliberately reported as what they demonstrably are — a ZIP — rather than
 * guessed at from the extension. A caller that needs the distinction has to
 * read the archive's `[Content_Types].xml`, which is a decision for whoever
 * needs it rather than a guess made here.
 */
const ZIP = { contentType: 'application/zip', extension: 'zip' };

export function detectType(content: Buffer): DetectedType | undefined {
  for (const signature of SIGNATURES) {
    if (signature.matches(content)) {
      return { contentType: signature.contentType, extension: signature.extension };
    }
  }

  if (bytes(content, [0x50, 0x4b, 0x03, 0x04]) || bytes(content, [0x50, 0x4b, 0x05, 0x06])) {
    return { ...ZIP };
  }

  return undefined;
}

/**
 * Whether a file is one of the types this request will accept.
 *
 * Takes the accepted list from the caller, because what is acceptable is a
 * property of what is being collected — an identity document and a bank
 * statement have different answers — and never a property of this package.
 */
export function isAccepted(content: Buffer, accepted: readonly string[]): boolean {
  const detected = detectType(content);
  return detected !== undefined && accepted.includes(detected.contentType);
}

function starts(content: Buffer, prefix: string): boolean {
  return content.subarray(0, prefix.length).toString('ascii') === prefix;
}

function bytes(content: Buffer, expected: number[]): boolean {
  if (content.length < expected.length) return false;
  return expected.every((byte, index) => content[index] === byte);
}
