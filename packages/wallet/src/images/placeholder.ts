import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

/**
 * A plain PNG of exactly the dimensions asked for.
 *
 * Production code, not a fixture — though the fixtures use it too. **Every pass
 * must carry an icon**, and a business that has just signed up has not uploaded
 * one: without this the first pass they preview cannot be built at all, and the
 * fifteen-minute path from signing up to a poster on the counter has a wall in
 * the middle of it. A rectangle in their own colours is a poor logo and a
 * perfectly good placeholder.
 *
 * Hand-written rather than reached for: `sharp` is libvips — a native binary and
 * a hundred megabytes — and the alternative to that is a checked-in binary
 * nobody can read in a diff. Writing a solid PNG is a header, one deflated
 * scanline block and a checksum.
 */
export function solidPng(width: number, height: number, colour = { r: 0, g: 0, b: 0 }): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(2, 9); // truecolour RGB
  header.writeUInt8(0, 10); // deflate
  header.writeUInt8(0, 11); // adaptive filtering
  header.writeUInt8(0, 12); // no interlace

  /* One filter byte per scanline, then three bytes per pixel. */
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let row = 0; row < height; row += 1) {
    const start = row * (1 + width * 3);
    raw.writeUInt8(0, start);
    for (let column = 0; column < width; column += 1) {
      const at = start + 1 + column * 3;
      raw.writeUInt8(colour.r, at);
      raw.writeUInt8(colour.g, at + 1);
      raw.writeUInt8(colour.b, at + 2);
    }
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

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

/** A stable digest of an image, for a test that wants to say "the same one". */
export const fingerprint = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex').slice(0, 16);
