/**
 * Just enough PNG to know how big an image is.
 *
 * Hand-written rather than pulled from an image library, and the distinction is
 * the one the repository's conventions draw: decoding a PNG is somebody else's
 * solved problem, and reading the eight bytes of its header is not decoding. The
 * alternative here is `sharp`, which is libvips — a native binary, a peer
 * dependency and a hundred megabytes — to answer a question the file states in
 * its first twenty-four bytes.
 *
 * It refuses anything that is not a PNG rather than guessing, because that
 * refusal is itself one of the rules (`pngOnly`).
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface PngSize {
  width: number;
  height: number;
}

/**
 * The dimensions of a PNG, or `null` if the bytes are not one.
 *
 * `null` rather than a throw: the caller is validating a whole pass and wants
 * every problem at once, not the first one.
 */
export function readPngSize(bytes: Uint8Array): PngSize | null {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  /*
   * Signature, then the IHDR chunk, which the format requires to come first.
   * 8 signature + 4 length + 4 type + 8 of dimensions = 24 bytes minimum.
   */
  if (buffer.length < 24) return null;
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) return null;
  if (buffer.subarray(12, 16).toString('ascii') !== 'IHDR') return null;

  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);

  /* A dimension of zero is a malformed file that some decoders accept. */
  if (width === 0 || height === 0) return null;

  return { width, height };
}
