import {
  PDFDocument,
  concatTransformationMatrix,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  type PDFFont,
  type PDFImage,
  type PDFPage,
  type RGB,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { ValidationError } from '@birtalanrobert/http';
import { detectType } from '../detect';
import { QUIET_ZONE, qrMatrix, qrRuns, type ErrorCorrection } from './qr';

/** One printed thing: a table tent, a counter poster, a card in an envelope. */
export interface PrintableCard {
  /** What the code encodes. A URL, in every product that has needed this. */
  readonly url: string;
  /** The large line above the code: a table number, a seat, a guest's name. */
  readonly heading?: string;
  /** Under the code, and the only instruction most people read. */
  readonly caption?: string;
  /** Small, at the foot: the business's name, or a code to type instead. */
  readonly footnote?: string;
}

/**
 * What comes out of the printer.
 *
 * - `a4` — one card to a sheet. A poster for a counter or a window.
 * - `a5` — two to a sheet, cut once along the marked line.
 * - `tent` — one to a sheet, printed twice and folded across the middle so it
 *   stands on a table and reads from both sides.
 */
export type CardFormat = 'a4' | 'a5' | 'tent';

export interface PrintableCardsOptions {
  readonly format?: CardFormat;
  readonly title?: string;
  /**
   * The typeface, as TrueType, OpenType or WOFF bytes.
   *
   * **Required, and deliberately not defaulted.** PDF's built-in fonts are
   * WinAnsi-encoded, which has no `ș`, no `ț` and no `ő` — so a default would
   * work in development and throw on the first Romanian venue name, or worse,
   * print `Serban` for `Șerban`. Which typeface a product prints in is a
   * decision it should be making anyway.
   */
  readonly font: Buffer;
  /** For the heading. Falls back to `font`, which reads as a lighter design. */
  readonly boldFont?: Buffer;
  /** `#rrggbb`. Colours the heading and the rules; never the code. */
  readonly brandColour?: string;
  /** PNG or JPEG bytes, placed above the heading. */
  readonly logo?: Buffer;
  readonly errorCorrection?: ErrorCorrection;
}

const A4 = { width: 595.28, height: 841.89 };

/** A hairline: visible enough to cut or fold along, faint enough not to be furniture. */
const RULE_WIDTH = 0.5;

interface Panel {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface Furniture {
  readonly font: PDFFont;
  readonly bold: PDFFont;
  readonly logo: PDFImage | null;
  readonly brand: RGB;
  readonly level: ErrorCorrection;
}

/**
 * Print-ready cards with a code on each.
 *
 * The artefact that makes a product exist in a shop. A venue that has signed up
 * and not printed its tents has not started, and "design twenty cards with a
 * different code on each" is the step where they stop — which is why this is a
 * feature rather than a support article with a template attached.
 *
 * **The words are the caller's.** This lays out a code, a heading, a caption and
 * a footnote on paper that folds and cuts where the marks say; what any of them
 * say is the product's, and a shared component that decided would be one every
 * product has to fight.
 */
export async function printableCards(
  cards: readonly PrintableCard[],
  options: PrintableCardsOptions,
): Promise<Buffer> {
  if (cards.length === 0) {
    throw new ValidationError([
      { field: 'cards', message: 'There is nothing to print.', code: 'no_cards' },
    ]);
  }

  const format = options.format ?? 'a4';
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);

  if (options.title) pdf.setTitle(options.title);
  /*
   * No producer, no creation date. Both default to something identifying, and
   * it is what makes the output deterministic — which is what lets a test
   * assert that the same tables produce the same bytes.
   */
  pdf.setProducer('');
  pdf.setCreator('');

  const furniture: Furniture = {
    /*
     * **Embedded whole, not subset.** `@pdf-lib/fontkit`'s subsetter drops
     * glyphs from ordinary static TrueType fonts — `Masa 12` comes out as
     * `M   2`, with the missing letters still in the text layer, so it copies
     * and searches correctly and is wrong only on paper. Nothing in a test that
     * counts pages sees it; the first thing that does is a printed tent.
     *
     * The cost is the typeface once per *document*, not per card, so a sheet of
     * twenty tables is one font and twenty codes.
     */
    font: await pdf.embedFont(own(options.font)),
    bold: await pdf.embedFont(own(options.boldFont ?? options.font)),
    logo: options.logo ? await embedLogo(pdf, options.logo) : null,
    brand: colourOf(options.brandColour),
    level: options.errorCorrection ?? 'M',
  };

  for (const group of chunk(cards, format === 'a5' ? 2 : 1)) {
    const page = pdf.addPage([A4.width, A4.height]);

    if (format === 'tent') drawTent(page, group[0]!, furniture);
    else drawCut(page, group, furniture, format);
  }

  return Buffer.from(await pdf.save());
}

/**
 * A table tent: the same card twice on one sheet, folded across the middle.
 *
 * The upper half is rotated by half a turn, which is the whole trick — folded
 * away from the reader, the two halves face opposite sides of the table and
 * both read upright. Printed the obvious way, one of them is upside down, and
 * the venue discovers that after printing twenty of them.
 */
function drawTent(page: PDFPage, card: PrintableCard, furniture: Furniture): void {
  const half = A4.height / 2;

  drawCard(page, card, { x: 0, y: 0, width: A4.width, height: half }, furniture);

  /*
   * Half a turn about the centre of the upper panel. `[-1, 0, 0, -1, 2cx, 2cy]`
   * is a 180° rotation composed with the translation that puts the centre back
   * where it was, which for this one angle needs no trigonometry.
   */
  const centreX = A4.width / 2;
  const centreY = half + half / 2;

  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(-1, 0, 0, -1, 2 * centreX, 2 * centreY),
  );
  drawCard(page, card, { x: 0, y: half, width: A4.width, height: half }, furniture);
  page.pushOperators(popGraphicsState());

  /* Where to fold. Dashed, so it is never mistaken for a border to cut along. */
  page.drawLine({
    start: { x: 0, y: half },
    end: { x: A4.width, y: half },
    thickness: RULE_WIDTH,
    color: furniture.brand,
    opacity: 0.4,
    dashArray: [4, 4],
  });
}

/** One or two cards to a sheet, with a solid line where the guillotine goes. */
function drawCut(
  page: PDFPage,
  cards: readonly PrintableCard[],
  furniture: Furniture,
  format: CardFormat,
): void {
  const rows = format === 'a5' ? 2 : 1;
  const height = A4.height / rows;

  cards.forEach((card, index) => {
    /* Filled from the top, so a sheet with one card on it has it where a reader looks. */
    const y = A4.height - height * (index + 1);
    drawCard(page, card, { x: 0, y, width: A4.width, height }, furniture);
  });

  if (rows === 2) {
    page.drawLine({
      start: { x: 0, y: height },
      end: { x: A4.width, y: height },
      thickness: RULE_WIDTH,
      color: furniture.brand,
      opacity: 0.4,
    });
  }
}

/**
 * One card, inside the rectangle it was given.
 *
 * Laid out from the outside in: the fixed things claim their space from the top
 * and the bottom, and the code takes the largest square left over. The other
 * way round — a fixed code size with text fitted around it — is what produces a
 * heading that overlaps the quiet zone the first time a table is called
 * "Terasa 12" instead of "12".
 */
function drawCard(page: PDFPage, card: PrintableCard, panel: Panel, furniture: Furniture): void {
  const padding = Math.min(panel.width, panel.height) * 0.08;
  const inner = panel.width - padding * 2;

  let top = panel.y + panel.height - padding;
  let bottom = panel.y + padding;

  if (furniture.logo) {
    const height = Math.min(panel.height * 0.09, furniture.logo.height);
    const width = (furniture.logo.width / furniture.logo.height) * height;
    const scale = width > inner ? inner / width : 1;

    page.drawImage(furniture.logo, {
      x: panel.x + (panel.width - width * scale) / 2,
      y: top - height * scale,
      width: width * scale,
      height: height * scale,
    });

    top -= height * scale + padding * 0.5;
  }

  if (card.heading) {
    const size = fit(card.heading, furniture.bold, inner, panel.height * 0.18);
    page.drawText(card.heading, {
      x: panel.x + (panel.width - furniture.bold.widthOfTextAtSize(card.heading, size)) / 2,
      y: top - size,
      size,
      font: furniture.bold,
      color: furniture.brand,
    });

    top -= size + padding * 0.6;
  }

  if (card.footnote) {
    const size = fit(card.footnote, furniture.font, inner, panel.height * 0.045);
    page.drawText(card.footnote, {
      x: panel.x + (panel.width - furniture.font.widthOfTextAtSize(card.footnote, size)) / 2,
      y: bottom,
      size,
      font: furniture.font,
      color: rgb(0.45, 0.45, 0.45),
    });

    bottom += size + padding * 0.6;
  }

  if (card.caption) {
    const size = fit(card.caption, furniture.font, inner, panel.height * 0.07);
    page.drawText(card.caption, {
      x: panel.x + (panel.width - furniture.font.widthOfTextAtSize(card.caption, size)) / 2,
      y: bottom,
      size,
      font: furniture.font,
      color: rgb(0.1, 0.1, 0.1),
    });

    bottom += size + padding * 0.8;
  }

  drawQr(page, card.url, furniture.level, {
    x: panel.x + padding,
    y: bottom,
    width: inner,
    height: Math.max(0, top - bottom),
  });
}

/**
 * The code itself, centred in the space left for it.
 *
 * **Black on white, whatever the venue's colours are.** A tinted code reads on
 * a phone in a showroom and fails on the one with a cracked lens in a dim
 * dining room, and the failure is silent — the guest simply gives up. The
 * heading above it is where a brand belongs.
 */
function drawQr(page: PDFPage, url: string, level: ErrorCorrection, box: Panel): void {
  const matrix = qrMatrix(url, level);
  /* The quiet zone is part of the code, so it is measured into the square. */
  const span = matrix.size + QUIET_ZONE * 2;
  const side = Math.min(box.width, box.height);
  if (side <= 0) return;

  const module = side / span;
  const left = box.x + (box.width - side) / 2 + QUIET_ZONE * module;
  const bottom = box.y + (box.height - side) / 2 + QUIET_ZONE * module;

  for (const run of qrRuns(matrix)) {
    page.drawRectangle({
      x: left + run.x * module,
      /* PDF's origin is bottom-left; a QR's first row is its top one. */
      y: bottom + (matrix.size - run.y - 1) * module,
      width: run.length * module,
      height: module,
      color: rgb(0, 0, 0),
    });
  }
}

/** The largest size at which this fits the width, never above the ceiling. */
function fit(text: string, font: PDFFont, width: number, ceiling: number): number {
  const measured = font.widthOfTextAtSize(text, ceiling);
  if (measured <= width) return ceiling;

  return Math.max(4, (ceiling * width) / measured);
}

async function embedLogo(pdf: PDFDocument, bytes: Buffer): Promise<PDFImage> {
  const detected = detectType(bytes);

  if (detected?.contentType === 'image/png') return pdf.embedPng(own(bytes));
  if (detected?.contentType === 'image/jpeg') return pdf.embedJpg(own(bytes));

  throw new ValidationError([
    {
      field: 'logo',
      message: 'A logo has to be a PNG or a JPEG.',
      code: 'unembeddable_logo',
    },
  ]);
}

/**
 * A copy in its own `ArrayBuffer`, before anything is handed to `pdf-lib`.
 *
 * It reads the **whole** backing buffer and ignores a view's `byteOffset`, and
 * Node allocates every Buffer under 4 KB out of a shared 8 KB pool — so a small
 * logo arrives at a non-zero offset and the embedder parses whatever happens to
 * sit at the pool's start. Whether it happens depends on what else the process
 * allocated, so it passes in a test and fails in production with `SOI not found
 * in JPEG`. An offset-aware view does not help; it shares the same
 * `ArrayBuffer`. Only a copy does. (The same trap `assemblePdf` documents.)
 */
function own(bytes: Buffer): Uint8Array {
  return Uint8Array.from(bytes);
}

function colourOf(hex: string | undefined): RGB {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!match) return rgb(0.1, 0.1, 0.1);

  const value = Number.parseInt(match[1]!, 16);
  return rgb(((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255);
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    groups.push(items.slice(index, index + size));
  }

  return groups;
}
