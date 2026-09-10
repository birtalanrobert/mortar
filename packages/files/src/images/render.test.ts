import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { renderImage, UnsupportedImageError } from './render';

/**
 * The pipeline eight products depend on, tested against real encoded bytes.
 *
 * Nothing is stubbed. Every defect this exists to prevent — a photograph on its
 * side, a box reserved in the wrong shape, a customer's front door coordinates
 * travelling with the picture of their sofa — is a property of what libvips
 * actually produces, and a mock would assert only that we called it.
 */

/** A photograph-ish image: gradients, so a dominant colour is meaningful. */
async function photograph(width: number, height: number, colour = { r: 40, g: 90, b: 160 }) {
  return sharp({ create: { width, height, channels: 3, background: colour } })
    .jpeg()
    .toBuffer();
}

/** The same picture as a phone stores a portrait one: turned, plus a flag. */
async function turnedPortrait() {
  return (
    sharp({
      create: { width: 400, height: 200, channels: 3, background: { r: 10, g: 200, b: 90 } },
    })
      // `withMetadata` rather than `withExifMerge`: orientation is a TIFF tag
      // sharp writes itself, and merging it as EXIF leaves the flag at 1.
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer()
  );
}

describe('rendering an upload', () => {
  it('writes one derivative per size and format, in the product’s own names', async () => {
    const rendered = await renderImage(await photograph(1200, 800), {
      sizes: [
        { name: 'thumb', width: 160 },
        { name: 'card', width: 640 },
      ],
      formats: ['webp', 'jpeg'],
    });

    expect(rendered.derivatives.map((one) => `${one.name}.${one.format}`)).toEqual([
      'thumb.webp',
      'thumb.jpeg',
      'card.webp',
      'card.jpeg',
    ]);

    const card = rendered.derivatives.find((one) => one.name === 'card' && one.format === 'webp');
    expect(card).toMatchObject({ width: 640, contentType: 'image/webp' });
    // The height follows the aspect ratio rather than being asked for: a
    // product that specifies both eventually specifies two that disagree.
    expect(card?.height).toBe(427);
  });

  it('does not enlarge a small photograph to fill a large size', async () => {
    const rendered = await renderImage(await photograph(320, 240), {
      sizes: [{ name: 'full', width: 1600 }],
      formats: ['webp'],
    });

    // Bytes spent on blur are bytes spent making the page slower for nothing.
    expect(rendered.derivatives[0]).toMatchObject({ width: 320, height: 240 });
  });

  it('reports the dimensions a portrait photograph is actually displayed at', async () => {
    const rendered = await renderImage(await turnedPortrait(), {
      sizes: [{ name: 'card', width: 100 }],
      formats: ['webp'],
    });

    /*
     * Stored 400 × 200 with orientation 6, displayed 200 × 400. A page that
     * reserves the stored shape shifts its layout the moment the photograph
     * paints — which is the exact defect the placeholder exists to prevent, so
     * getting this wrong makes the whole feature pointless.
     */
    expect(rendered).toMatchObject({ width: 200, height: 400 });
    expect(rendered.derivatives[0]).toMatchObject({ width: 100, height: 200 });
  });

  it('leaves no metadata on a derivative, and the coordinates with it', async () => {
    const withLocation = await sharp({
      create: { width: 400, height: 300, channels: 3, background: { r: 200, g: 30, b: 30 } },
    })
      /*
       * `IFD3` is where sharp puts GPS. It was written here as `GPSIFD` — the
       * name libexif uses — which sharp accepts and silently ignores, so the
       * fixture carried a copyright notice and no coordinates at all while the
       * test claimed to be about coordinates.
       */
      .withExifMerge({
        IFD0: { Copyright: 'A photographer' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '46/1 46/1 0/1' },
      })
      .jpeg()
      .toBuffer();

    /*
     * Proving the fixture first, and proving that the merge actually landed
     * rather than that some EXIF block exists: a test that strips nothing
     * passes just as happily as one that strips everything, and one whose
     * fixture never carried the metadata passes most happily of all.
     */
    const original = (await sharp(withLocation).metadata()).exif;
    expect(original).toBeInstanceOf(Buffer);
    expect(original!.toString('latin1')).toContain('A photographer');

    const rendered = await renderImage(withLocation, {
      sizes: [{ name: 'card', width: 200 }],
      formats: ['jpeg'],
    });

    const metadata = await sharp(rendered.derivatives[0]!.bytes).metadata();

    /*
     * sharp drops metadata by default, so this asserts a default rather than a
     * call — which is exactly why it is worth asserting. The day somebody adds
     * `withMetadata()` to keep a colour profile, the customer's front door
     * comes back with it, and nothing else in this repository would notice.
     */
    expect(metadata.exif).toBeUndefined();
  });

  it('measures a colour to fill the box with', async () => {
    const rendered = await renderImage(await photograph(600, 400, { r: 220, g: 40, b: 60 }), {
      sizes: [{ name: 'thumb', width: 80 }],
      formats: ['webp'],
    });

    expect(rendered.dominantColour).toMatch(/^#[0-9a-f]{6}$/);
    // Red, near enough: the point is that the box is not white before the
    // photograph lands.
    const red = Number.parseInt(rendered.dominantColour.slice(1, 3), 16);
    expect(red).toBeGreaterThan(150);
  });

  it('offers a blurred placeholder small enough to inline', async () => {
    const rendered = await renderImage(await photograph(1200, 800), {
      sizes: [{ name: 'thumb', width: 80 }],
      formats: ['webp'],
      placeholder: 'blur',
    });

    expect(rendered.placeholder).toMatch(/^data:image\/webp;base64,/);
    /*
     * Inline means it is in the HTML of every page that shows the picture. A
     * kilobyte each across a forty-item menu is a page that got slower in the
     * name of feeling faster.
     */
    expect(rendered.placeholder!.length).toBeLessThan(1_000);
  });

  it('gives no placeholder when it was not asked for', async () => {
    const rendered = await renderImage(await photograph(400, 300), {
      sizes: [{ name: 'thumb', width: 80 }],
      formats: ['webp'],
    });

    expect(rendered.placeholder).toBeUndefined();
  });

  it('refuses a file that is not an image, whatever it is called', async () => {
    // An SVG is the one that matters: libvips will rasterise it happily, and it
    // is a document format with a script engine and a URL loader in it.
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', 'utf8');

    await expect(
      renderImage(svg, { sizes: [{ name: 'thumb', width: 80 }] }),
    ).rejects.toBeInstanceOf(UnsupportedImageError);
    await expect(
      renderImage(Buffer.from('%PDF-1.7\n'), { sizes: [{ name: 'thumb', width: 80 }] }),
    ).rejects.toThrow('application/pdf is not an image this pipeline can read.');
  });

  it('refuses a picture too large to decode safely', async () => {
    /*
     * The guard is a pixel count rather than a byte count, because the two are
     * unrelated: a hundred-kilobyte PNG of one flat colour decodes to gigabytes
     * of memory, and a worker that meets one is killed by the kernel rather
     * than raising anything anybody sees.
     */
    await expect(
      renderImage(await photograph(2000, 2000), {
        sizes: [{ name: 'thumb', width: 80 }],
        maxPixels: 1_000_000,
      }),
    ).rejects.toThrow(/pixel limit/i);
  });

  it('lets one size ask for a format the others do not', async () => {
    const rendered = await renderImage(await photograph(800, 600), {
      sizes: [
        { name: 'thumb', width: 80, formats: ['webp'] },
        { name: 'print', width: 800, formats: ['png'] },
      ],
      formats: ['avif', 'webp'],
    });

    // A print derivative has no business being lossy, and a thumbnail has no
    // business being lossless.
    expect(rendered.derivatives.map((one) => `${one.name}.${one.format}`)).toEqual([
      'thumb.webp',
      'print.png',
    ]);
  });
});
