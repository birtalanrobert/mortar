import { describe, expect, it } from 'vitest';
import { detectType, isAccepted } from './detect';

const pdf = Buffer.from('%PDF-1.7\nrest of the document');
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64),
]);
const heic = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from('ftypheic', 'ascii'),
  Buffer.alloc(64),
]);
const webp = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('WEBP', 'ascii'),
  Buffer.alloc(32),
]);
const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]);

describe('detectType', () => {
  it.each([
    ['a PDF', pdf, 'application/pdf', 'pdf'],
    ['a JPEG', jpeg, 'image/jpeg', 'jpg'],
    ['a PNG', png, 'image/png', 'png'],
    ['a photo from an iPhone', heic, 'image/heic', 'heic'],
    ['a WebP', webp, 'image/webp', 'webp'],
  ])('recognises %s', (_, content, contentType, extension) => {
    expect(detectType(content)).toEqual({ contentType, extension });
  });

  it('recognises a TIFF in both byte orders', () => {
    expect(detectType(Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08]))?.extension).toBe('tif');
    expect(detectType(Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0x08]))?.extension).toBe('tif');
  });

  it('reports an Office document as the ZIP it demonstrably is', () => {
    // Guessing between .docx, .xlsx and a plain archive from four bytes is not
    // possible; guessing from the extension is trusting the uploader.
    expect(detectType(zip)).toEqual({ contentType: 'application/zip', extension: 'zip' });
  });

  it('does not recognise something it has no signature for', () => {
    expect(detectType(Buffer.from('just some text, honestly'))).toBeUndefined();
    expect(detectType(Buffer.alloc(0))).toBeUndefined();
    expect(detectType(Buffer.from([0xff]))).toBeUndefined();
  });

  it('is not fooled by a name or a header', () => {
    // The exact scenario this exists to prevent: an executable a database row
    // would otherwise insist is a PDF.
    const executable = Buffer.concat([Buffer.from('MZ', 'ascii'), Buffer.alloc(64)]);

    expect(detectType(executable)).toBeUndefined();
  });

  it('reads the signature, not a later occurrence of it', () => {
    const sneaky = Buffer.concat([Buffer.from('GIF89a'), pdf]);

    expect(detectType(sneaky)).toBeUndefined();
  });
});

describe('isAccepted', () => {
  const accepted = ['application/pdf', 'image/jpeg'];

  it('accepts what is on the list', () => {
    expect(isAccepted(pdf, accepted)).toBe(true);
    expect(isAccepted(jpeg, accepted)).toBe(true);
  });

  it('refuses what is not', () => {
    expect(isAccepted(png, accepted)).toBe(false);
  });

  it('refuses what it cannot identify', () => {
    // Unknown is refused rather than allowed: an unrecognised file is exactly
    // the one worth being careful about.
    expect(isAccepted(Buffer.from('hello'), accepted)).toBe(false);
  });

  it('refuses everything when nothing is accepted', () => {
    expect(isAccepted(pdf, [])).toBe(false);
  });
});
