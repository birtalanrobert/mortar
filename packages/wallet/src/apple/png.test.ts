import { describe, expect, it } from 'vitest';
import { solidPng } from '../testing';
import { readPngSize } from './png';

describe('reading a PNG’s size', () => {
  it('reads the dimensions out of the header', () => {
    expect(readPngSize(solidPng(375, 123))).toEqual({ width: 375, height: 123 });
    expect(readPngSize(solidPng(29, 29))).toEqual({ width: 29, height: 29 });
  });

  it('refuses a JPEG, a GIF and an SVG rather than guessing', () => {
    expect(readPngSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(40).fill(0)]))).toBeNull();
    expect(readPngSize(Buffer.from('GIF89a' + 'x'.repeat(40)))).toBeNull();
    expect(
      readPngSize(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="29"></svg>')),
    ).toBeNull();
  });

  it('refuses something too short to be a PNG', () => {
    expect(readPngSize(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });

  it('refuses a PNG whose first chunk is not the header', () => {
    const png = solidPng(10, 10);
    png.write('IDAT', 12, 'ascii');

    expect(readPngSize(png)).toBeNull();
  });

  it('refuses a zero dimension, which some decoders accept', () => {
    const png = solidPng(10, 10);
    png.writeUInt32BE(0, 16);

    expect(readPngSize(png)).toBeNull();
  });
});
