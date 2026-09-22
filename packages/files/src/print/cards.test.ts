import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { printableCards } from './cards';
import { renderDrawing } from './drawing';

/**
 * A real typeface, because the thing being tested is that a Romanian venue's
 * name reaches paper. PDF's built-in fonts cannot encode `ș`, which is exactly
 * why this module refuses to default one.
 */
const NOTO = readFileSync(
  require.resolve('@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf'),
);

const CARD = {
  url: 'https://taverna.example/t/K3M9',
  heading: '12',
  caption: 'Scanați pentru a comanda',
  footnote: 'Bistroul Șerban',
};

async function pagesOf(pdf: Buffer): Promise<number> {
  return (await PDFDocument.load(pdf)).getPageCount();
}

/**
 * The field code a refusal carries.
 *
 * Asserted rather than the message: a `ValidationError`'s message is the
 * generic one every field failure shares, so matching on it would pass for the
 * wrong refusal.
 */
async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
    return undefined;
  } catch (error) {
    return (error as { errors?: Array<{ code?: string }> }).errors?.[0]?.code;
  }
}

describe('printableCards', () => {
  it('prints a sheet per card', async () => {
    const pdf = await printableCards([CARD, { ...CARD, heading: '13' }], { font: NOTO });

    expect(await pagesOf(pdf)).toBe(2);
  });

  /**
   * Two to a sheet is the reason the A5 format exists: twenty tables is ten
   * sheets and ten cuts, rather than twenty sheets each half wasted.
   */
  it('puts two A5 cards on one sheet', async () => {
    const cards = Array.from({ length: 5 }, (_, index) => ({ ...CARD, heading: String(index) }));
    const pdf = await printableCards(cards, { font: NOTO, format: 'a5' });

    /* Five cards is three sheets: the last one carries a single card. */
    expect(await pagesOf(pdf)).toBe(3);
  });

  it('prints a tent as one sheet holding the card twice', async () => {
    const one = await printableCards([CARD], { font: NOTO, format: 'tent' });
    const flat = await printableCards([CARD], { font: NOTO, format: 'a4' });

    expect(await pagesOf(one)).toBe(1);
    /*
     * The same card drawn twice and a fold line, so the tent's page is the
     * larger of the two. A tent that came out the same size as the flat sheet
     * would mean the second half never made it onto the page — which nothing
     * else here would notice, because both are valid PDFs of one page.
     */
    expect(one.length).toBeGreaterThan(flat.length);
  });

  /**
   * The reason a typeface is a required argument. This throws on a built-in
   * font, and the failure would arrive on the first venue whose name has a
   * comma-below in it rather than in development.
   */
  it('sets Romanian and Hungarian text without complaint', async () => {
    const pdf = await printableCards(
      [{ ...CARD, heading: 'Terasă 4', footnote: 'Bistroul Șerban · Étterem őszi' }],
      { font: NOTO },
    );

    expect(await pagesOf(pdf)).toBe(1);
  });

  /**
   * The typeface once per document, not once per card.
   *
   * It is embedded whole — `@pdf-lib/fontkit`'s subsetter drops glyphs from
   * this very font — so the thing to hold is that twenty tables cost one copy
   * of it rather than twenty.
   */
  it('embeds the typeface once however many cards there are', async () => {
    const one = await printableCards([CARD], { font: NOTO });
    const twenty = await printableCards(
      Array.from({ length: 20 }, (_, index) => ({ ...CARD, heading: String(index) })),
      { font: NOTO },
    );

    expect(twenty.length).toBeLessThan(one.length * 1.5);
  });

  /**
   * The whole typeface goes in, and this is the check that says so.
   *
   * `@pdf-lib/fontkit`'s subsetter drops glyphs from ordinary static fonts —
   * `Masa 12` prints as `M   2` while the text layer still reads `Masa 12`, so
   * it copies, searches and extracts correctly and is wrong only on paper.
   * Nothing else here could see it: the page count was right, the extracted
   * text was right, and the card was unusable. A document smaller than its own
   * typeface is a document that has been subset again.
   */
  it('embeds the typeface whole, because subsetting it loses letters', async () => {
    const pdf = await printableCards([CARD], { font: NOTO });

    expect(pdf.length).toBeGreaterThan(NOTO.length);
  });

  /**
   * The detail lines a ticket needs and a table tent does not.
   *
   * What is actually being checked is that they are *drawn* — a layout that
   * accepted the array and quietly ran out of room would still produce a valid
   * one-page PDF, which is the failure nothing else here would see. A page
   * carrying four more lines of text is a longer content stream than one
   * carrying none.
   */
  it('prints the detail lines under the caption', async () => {
    const bare = await printableCards([CARD], { font: NOTO });
    const detailed = await printableCards(
      [
        {
          ...CARD,
          lines: ['14 noiembrie 2027, 19:30', 'Sala Mare · Rândul F, locul 12', 'Ana Popescu'],
        },
      ],
      { font: NOTO },
    );

    expect(await pagesOf(detailed)).toBe(1);
    expect(detailed.length).toBeGreaterThan(bare.length);
  });

  /**
   * A line too long for the card shrinks, like every other string here. The
   * alternative is text drawn past the edge, which is simply not on the paper
   * and which nothing in a page count can see.
   */
  it('shrinks a detail line that will not fit', async () => {
    const pdf = await printableCards(
      [
        {
          ...CARD,
          lines: ['Sala Mare, sectorul de nord-vest, rândul F, locul 12, intrarea dinspre parc'],
        },
      ],
      { font: NOTO },
    );

    expect(await pagesOf(pdf)).toBe(1);
  });

  it('refuses to print nothing', async () => {
    expect(await codeOf(printableCards([], { font: NOTO }))).toBe('no_cards');
  });

  it('refuses an image a PDF cannot hold', async () => {
    expect(
      await codeOf(printableCards([CARD], { font: NOTO, logo: Buffer.from('GIF89a not really') })),
    ).toBe('unembeddable_image');

    expect(
      await codeOf(
        printableCards([{ ...CARD, plan: Buffer.from('GIF89a not really') }], { font: NOTO }),
      ),
    ).toBe('unembeddable_image');
  });

  /**
   * A card with nothing but a code is legitimate — a sheet of collection codes,
   * a strip of stickers — and must not depend on the layout finding text to
   * hang the code beneath.
   */
  it('lays out a card with no words on it', async () => {
    const pdf = await printableCards([{ url: 'https://taverna.example/c' }], { font: NOTO });

    expect(await pagesOf(pdf)).toBe(1);
  });

  /**
   * A plan is per card, and that is the whole reason it is not beside the logo.
   *
   * A sheet of four tickets is four different seats; one drawing shared between
   * them would be a map that is right about a quarter of the sheet.
   */
  it('gives each card its own plan', async () => {
    const one = await plan('#c1121f');
    const other = await plan('#1d4ed8');

    const pdf = await printableCards(
      [
        { ...CARD, heading: 'F 11', plan: one },
        { ...CARD, heading: 'F 12', plan: other },
      ],
      { font: NOTO, format: 'a5' },
    );

    expect(await pagesOf(pdf)).toBe(1);
    /* Both are in the document rather than one embedded twice, which is what a
       shared image would look like from the outside. */
    expect(await imagesOf(pdf)).toBe(2);
  });

  it('prints a card with no plan exactly as before', async () => {
    const without = await printableCards([CARD], { font: NOTO });

    expect(await imagesOf(without)).toBe(0);
    expect(await pagesOf(without)).toBe(1);
  });

  /**
   * A long table label shrinks rather than running off the card. The failure it
   * replaces is silent: text drawn past the edge is simply not on the paper.
   */
  it('shrinks a heading that will not fit rather than overflowing', async () => {
    const long = await printableCards([{ ...CARD, heading: 'Terasa de la etajul doi, masa 14' }], {
      font: NOTO,
    });

    expect(await pagesOf(long)).toBe(1);
  });
});

/**
 * Turning a drawing into pixels.
 *
 * The thing worth asserting is the refusal, not the rasteriser: this is the one
 * door in the package that accepts an SVG, and everything about whether that is
 * safe rests on it being handed a string the product generated rather than a
 * file somebody uploaded.
 */
describe('renderDrawing', () => {
  it('produces a PNG at the width it was asked for', async () => {
    const png = await renderDrawing(svg('#c1121f'), { width: 200 });

    /* The PNG signature, read from the bytes rather than trusted. */
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    /* Width lives in the IHDR, big-endian, at byte 16. */
    expect(png.readUInt32BE(16)).toBe(200);
  });

  it('refuses something that is not a drawing at all', async () => {
    await expect(renderDrawing('<html><body>no</body></html>', { width: 100 })).rejects.toThrow();
    await expect(renderDrawing(svg('#000'), { width: 0 })).rejects.toThrow();
    await expect(renderDrawing(svg('#000'), { width: 40_000 })).rejects.toThrow();
  });

  it('flattens onto paper rather than leaving it transparent', async () => {
    /*
     * A PDF viewer composites transparency against whatever is behind it — the
     * paper on a printed sheet, and sometimes black on a screen. A map drawn in
     * dark grey disappears for half the people who open it.
     */
    const png = await renderDrawing(svg('#c1121f'), { width: 60 });

    /* Colour type 2 is RGB with no alpha channel; 6 would be RGBA. */
    expect(png.readUInt8(25)).toBe(2);
  });
});

const svg = (colour: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20" width="40" height="20">` +
  `<circle cx="10" cy="10" r="4" fill="${colour}"/></svg>`;

const plan = (colour: string): Promise<Buffer> => renderDrawing(svg(colour), { width: 160 });

/** How many images a document actually embeds, by counting its XObjects. */
async function imagesOf(pdf: Buffer): Promise<number> {
  const document = await PDFDocument.load(pdf);

  return document.context
    .enumerateIndirectObjects()
    .filter(([, object]) => String(object).includes('/Subtype /Image')).length;
}
