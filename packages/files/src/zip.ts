import { deflateRawSync } from 'node:zlib';
import { ValidationError } from '@birtalanrobert/http';

export interface ZipEntry {
  /**
   * The path inside the archive, `/` separated.
   *
   * Folders are implied by it — there are no directory entries, because every
   * extractor creates the parents and writing them as well is two sources of
   * truth about the same tree.
   */
  path: string;
  content: Uint8Array;
  /** Defaults to the archive's own timestamp. */
  modified?: Date;
}

export interface ZipOptions {
  /**
   * The timestamp written into every entry that does not carry its own.
   *
   * Required in spirit rather than in type: passing one makes the archive
   * **deterministic**, which is what lets a test assert bytes and a delivery
   * retry produce a file the destination recognises as the same. Defaults to
   * the epoch rather than to `now` for exactly that reason.
   */
  modified?: Date;
  /**
   * Skip compression.
   *
   * Photographs and PDFs are already compressed and deflating them costs
   * processor time to save a per-cent or two. Left on by default because a
   * request usually contains at least one thing that does compress, and the
   * writer falls back to storing whenever deflate produces something bigger.
   */
  store?: boolean;
}

/**
 * A ZIP archive, written by hand.
 *
 * Hand-written rather than pulled from a dependency because the format's
 * essential part is two hundred lines and every library that writes it brings a
 * stream stack, a plugin system and a supply chain — for a file layout that has
 * not changed since 1993. `node:zlib` supplies the only hard part.
 *
 * **Everything is held in memory.** A completed request is a handful of
 * documents of a few megabytes each, which this handles comfortably; an archive
 * of a whole firm's history is a different problem and wants a streaming writer.
 * The 4 GB ceiling is enforced rather than silently exceeded, because ZIP64 is
 * the answer to that and this is not it.
 */
export function createZip(entries: readonly ZipEntry[], options: ZipOptions = {}): Buffer {
  if (entries.length === 0) {
    throw new ValidationError(
      [{ field: 'entries', message: 'An archive needs at least one file.', code: 'empty_archive' }],
      'An archive needs at least one file.',
    );
  }

  const defaultModified = options.modified ?? new Date(0);
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  const seen = new Set<string>();

  for (const entry of entries) {
    const path = normalisePath(entry.path);

    /**
     * Two files at one path.
     *
     * Every extractor resolves this differently — some overwrite, some prompt,
     * some silently keep the first — so the one thing that must not happen is
     * for it to be decided by the extractor. The caller knows how to
     * disambiguate; this only knows that something is wrong.
     */
    if (seen.has(path)) {
      throw new ValidationError(
        [
          {
            field: 'entries',
            message: `Two files share the path “${path}”.`,
            code: 'duplicate_path',
          },
        ],
        `Two files share the path “${path}”.`,
      );
    }
    seen.add(path);

    const name = Buffer.from(path, 'utf8');
    const content = Buffer.from(
      entry.content.buffer,
      entry.content.byteOffset,
      entry.content.byteLength,
    );
    const crc = crc32(content);

    const deflated = options.store ? undefined : deflateRawSync(content);
    // Stored when deflate did not help: an already-compressed photograph
    // routinely inflates by a few bytes, and paying for that is absurd.
    const useDeflate = deflated !== undefined && deflated.length < content.length;
    const body = useDeflate ? deflated : content;
    const method = useDeflate ? 8 : 0;

    const { time, date } = dosTimestamp(entry.modified ?? defaultModified);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // Version 2.0: the floor for deflate.
    // Bit 11: the name is UTF-8. Without it an extractor reads a Romanian name
    // in the machine's own code page and produces mojibake.
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);

    locals.push(local, body);

    const header = Buffer.alloc(46 + name.length);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4); // Written by
    header.writeUInt16LE(20, 6); // Needed to extract
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(date, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(content.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30); // extra
    header.writeUInt16LE(0, 32); // comment
    header.writeUInt16LE(0, 34); // disk
    header.writeUInt16LE(0, 36); // internal attributes
    /*
     * 0o644 in the high two bytes, where a Unix extractor reads permissions
     * from — without it the files arrive as 000 on some tools.
     *
     * `>>> 0` because `<< 16` produces a *signed* 32-bit result in JavaScript,
     * and a regular file's mode sets the bit that makes it negative.
     */
    header.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    name.copy(header, 46);

    central.push(header);
    offset += local.length + body.length;

    if (offset > 0xffffffff) {
      throw new ValidationError(
        [
          {
            field: 'entries',
            message: 'This archive is too large for the ZIP format.',
            code: 'archive_too_large',
          },
        ],
        'This archive is too large for the ZIP format.',
      );
    }
  }

  const directory = Buffer.concat(central);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with the directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment

  return Buffer.concat([...locals, directory, end]);
}

/**
 * The path, made safe to extract.
 *
 * An archive is a set of filenames that a stranger's software will write to a
 * disk. A leading slash or a `..` segment is how an archive writes outside the
 * directory it was extracted into — the "zip slip" bug — and stripping them
 * here means no extractor's carefulness is being relied upon.
 */
function normalisePath(path: string): string {
  const segments = path
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..');

  if (segments.length === 0) {
    throw new ValidationError(
      [{ field: 'path', message: `“${path}” is not a usable path.`, code: 'invalid_path' }],
      `“${path}” is not a usable path.`,
    );
  }

  return segments.join('/');
}

/**
 * MS-DOS date and time, which is what ZIP stores.
 *
 * Two-second resolution and an epoch of 1980 — anything earlier, including the
 * Unix epoch this defaults to, clamps to the first representable moment rather
 * than wrapping into a date from the future.
 */
function dosTimestamp(when: Date): { time: number; date: number } {
  const year = when.getFullYear();
  if (year < 1980) return { time: 0, date: 0x0021 };

  return {
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
  };
}

/**
 * The table, built once.
 *
 * CRC-32 a byte at a time without one is eight shifts per byte, which on a
 * twenty-megabyte archive is the difference between milliseconds and seconds.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);

  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }

  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
