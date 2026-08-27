import { deflateSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { assemblePdf } from './pdf';

/**
 * A real PNG, built rather than pasted.
 *
 * PDF embedding rejects anything malformed, so a fixture has to be genuine —
 * and building one is both shorter than a base64 blob and says what it is.
 */
function png(width: number, height: number, grey = 0x80): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      raw[row + 1 + x * 3] = grey;
      raw[row + 2 + x * 3] = grey;
      raw[row + 3 + x * 3] = grey;
    }
  }

  const chunk = (type: string, body: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([length, typed, crc]);
  };

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * A 1×1 baseline JPEG.
 *
 * The smallest genuinely decodable one; hand-building a JPEG needs Huffman
 * tables, which is a fixture rather than a test.
 */
const JPEG = Buffer.from(
  '/9j/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB' +
    'AQEBAQEBAQEBAQEBAQH/wAALCAAIAAgBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcI' +
    'CQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAk' +
    'M2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqD' +
    'hIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl' +
    '5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/ACv/2Q==',
  'base64',
);

describe('assemblePdf', () => {
  it('makes one PDF from several pages, in order', async () => {
    const pdf = await assemblePdf([
      { content: png(600, 800) },
      { content: png(600, 800) },
      { content: png(600, 800) },
    ]);

    const loaded = await PDFDocument.load(pdf);

    /*
     * Three separate images of a statement means three files to open in the
     * right order — and the order is only knowable from filenames the client
     * did not choose, which is how page two gets filed before page one.
     */
    expect(loaded.getPageCount()).toBe(3);
  });

  it('is a PDF a reader will actually open', async () => {
    const pdf = await assemblePdf([{ content: png(100, 100) }]);

    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(pdf.subarray(-6).toString('ascii')).toContain('%%EOF');
  });

  it('embeds a JPEG without re-encoding it', async () => {
    const pdf = await assemblePdf([{ content: JPEG }]);

    // The whole reason to assemble server-side rather than rasterise: the
    // photograph reaches the professional as the bytes the camera produced,
    // not as a generational copy. `DCTDecode` is the filter that says so.
    expect(pdf.includes(Buffer.from('DCTDecode'))).toBe(true);
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1);
  });

  it('takes PNG as well, which is what a screenshot arrives as', async () => {
    const pdf = await assemblePdf([{ content: png(200, 200) }]);

    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1);
  });

  it('sizes each page to its image rather than floating it on A4', async () => {
    const pdf = await assemblePdf([{ content: png(600, 800) }], { maxEdge: 800 });
    const [page] = (await PDFDocument.load(pdf)).getPages();

    // A photograph floated on a fixed page leaves white margins a reader has
    // to zoom past on every page.
    expect(page!.getWidth()).toBeCloseTo(600, 0);
    expect(page!.getHeight()).toBeCloseTo(800, 0);
  });

  it('scales a large photograph down, keeping its shape', async () => {
    const pdf = await assemblePdf([{ content: png(2000, 1000) }], { maxEdge: 800 });
    const [page] = (await PDFDocument.load(pdf)).getPages();

    // A 4000-point page is fifty inches long; every reader zooms it to fit and
    // the page furniture is wrong on all of them.
    expect(page!.getWidth()).toBeCloseTo(800, 0);
    expect(page!.getHeight()).toBeCloseTo(400, 0);
  });

  it('leaves a small page alone rather than enlarging it', async () => {
    const pdf = await assemblePdf([{ content: png(200, 100) }], { maxEdge: 800 });
    const [page] = (await PDFDocument.load(pdf)).getPages();

    // Enlarging adds nothing a reader cannot do themselves, and makes the file
    // claim a resolution it does not have.
    expect(page!.getWidth()).toBeCloseTo(200, 0);
  });

  it('reads the type from the bytes, not from what it was told', async () => {
    // The same rule the upload path follows. A caller insisting a PNG is a
    // JPEG must not make the embedder try to decode it as one.
    const pdf = await assemblePdf([{ content: png(100, 100), contentType: 'image/jpeg' }]);

    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1);
  });

  it('embeds a page that arrived in a pooled buffer', async () => {
    /*
     * The bug this guards, which cost an hour to find.
     *
     * Node allocates every Buffer under 4 KB from a shared pool, so a small
     * page arrives at a non-zero `byteOffset` — and `pdf-lib` reads the whole
     * backing buffer, ignoring the offset, parsing whatever sits at the pool's
     * start. Whether that happens depends on what else the process has
     * allocated, which is why it passed here and would have failed in
     * production.
     */
    const pool = Buffer.alloc(4096); // zeroed: nothing at position 0 looks like an image
    const pooled = pool.subarray(1000, 1000 + JPEG.length);
    JPEG.copy(pooled);

    expect(pooled.byteOffset).toBeGreaterThan(0);
    expect((await PDFDocument.load(await assemblePdf([{ content: pooled }]))).getPageCount()).toBe(
      1,
    );
  });

  it('refuses a page that is not an embeddable image', async () => {
    await expect(
      assemblePdf([{ content: Buffer.from('%PDF-1.7 not an image') }]),
    ).rejects.toThrow();
    await expect(assemblePdf([{ content: Buffer.from('hello') }])).rejects.toThrow();
  });

  it('names the page that could not be embedded', async () => {
    // Three pages in and one is wrong: "a page failed" makes someone check all
    // three. The field lives in the problem's `errors`, not in its message.
    let failure: { errors?: Array<{ field: string }> } | undefined;
    try {
      await assemblePdf([{ content: png(50, 50) }, { content: Buffer.from('nope') }]);
    } catch (error) {
      failure = error as { errors?: Array<{ field: string }> };
    }

    expect(failure?.errors?.[0]?.field).toBe('pages[1]');
  });

  it('refuses to make a document with no pages', async () => {
    await expect(assemblePdf([])).rejects.toThrow();
  });

  it('writes no producer or creation date', async () => {
    // These are a client's bank statements; the defaults identify the software
    // that touched them. It also makes the output deterministic.
    const first = await assemblePdf([{ content: png(100, 100) }]);
    const second = await assemblePdf([{ content: png(100, 100) }]);

    expect(first.equals(second)).toBe(true);
  });

  it('carries a title when one is given', async () => {
    const pdf = await assemblePdf([{ content: png(100, 100) }], { title: 'Bank statement' });

    expect((await PDFDocument.load(pdf)).getTitle()).toBe('Bank statement');
  });
});
