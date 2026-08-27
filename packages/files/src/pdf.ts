import { PDFDocument } from 'pdf-lib';
import { ValidationError } from '@birtalanrobert/http';
import { detectType } from './detect';

export interface PdfPage {
  content: Buffer;
  /** Detected, not claimed. Optional — the bytes are re-read here regardless. */
  contentType?: string;
}

export interface AssembleOptions {
  /**
   * Longest edge of a page, in PDF points (72 to the inch).
   *
   * A4 is 842 points tall. Photographs come in far larger than that, and a PDF
   * that stores a 4000-pixel image on a 4000-point page is a document whose
   * pages are fifty inches long — every reader will zoom it to fit, and the
   * page furniture will be wrong on every one of them.
   */
  maxEdge?: number;
  title?: string;
}

/**
 * The image formats a page can be.
 *
 * PDF embeds JPEG and PNG natively — `DCTDecode` and `FlateDecode` — so both go
 * in **without being re-encoded**. That is the whole reason to assemble here
 * rather than to rasterise: a client's photograph reaches the professional as
 * the bytes their camera produced, not as a generational copy of them.
 *
 * HEIC is deliberately absent. A phone can produce it, no PDF reader can, and
 * converting it needs a decoder this package is not going to carry. The client
 * pipeline already converts captures to JPEG before upload; a HEIC arriving
 * here means it came from the file picker, and refusing is better than
 * embedding something that will not open.
 */
const EMBEDDABLE = new Set(['image/jpeg', 'image/png']);

const DEFAULT_MAX_EDGE = 842;

/**
 * Several photographed pages, as one PDF.
 *
 * The thing a professional actually wants. Three separate JPEGs of a bank
 * statement means three files to open in the right order, and the order is only
 * knowable from filenames a client did not choose — which is how page two ends
 * up filed before page one.
 *
 * Server-side rather than in the browser, deliberately: a PDF writer on every
 * phone to save one round trip is a poor trade, and the assembled document is
 * the one that has to be right.
 */
export async function assemblePdf(
  pages: readonly PdfPage[],
  options: AssembleOptions = {},
): Promise<Buffer> {
  if (pages.length === 0) {
    throw new ValidationError([
      { field: 'pages', message: 'A document needs at least one page.', code: 'no_pages' },
    ]);
  }

  const maxEdge = options.maxEdge ?? DEFAULT_MAX_EDGE;
  const pdf = await PDFDocument.create();

  if (options.title) pdf.setTitle(options.title);
  /**
   * No producer or creation date.
   *
   * Both default to something identifying, and these documents are a client's
   * bank statements. It also makes the output deterministic, which is what lets
   * a test assert that the same pages produce the same bytes.
   */
  pdf.setProducer('');
  pdf.setCreator('');

  for (const [index, page] of pages.entries()) {
    // Read from the bytes, never from what the caller said they were: the same
    // rule the upload path follows, for the same reason.
    const detected = detectType(page.content);
    if (!detected || !EMBEDDABLE.has(detected.contentType)) {
      throw new ValidationError([
        {
          field: `pages[${index}]`,
          message: 'That page is not an image a PDF can hold.',
          code: 'unembeddable_page',
        },
      ]);
    }

    /**
     * Copied into its own `ArrayBuffer` before it is handed over.
     *
     * `pdf-lib` reads the *whole* backing buffer and ignores a view's
     * `byteOffset`. Node allocates every Buffer under 4 KB out of a shared 8 KB
     * pool, so a small page — a compressed scan, a page fetched from storage —
     * arrives at a non-zero offset and the embedder parses whatever happens to
     * sit at the pool's start instead.
     *
     * The failure is worse than it sounds: whether it happens depends on what
     * else the process has allocated, so it passes in one test and fails in
     * production, with `SOI not found in JPEG` and nothing pointing at the
     * cause. An offset-aware *view* does not help — it shares the same
     * `ArrayBuffer`. Only a copy does.
     */
    const bytes = Uint8Array.from(page.content);

    const image =
      detected.contentType === 'image/jpeg' ? await pdf.embedJpg(bytes) : await pdf.embedPng(bytes);

    const { width, height } = fit(image.width, image.height, maxEdge);
    // One page per image, sized to the image: a fixed A4 page with a photograph
    // floated on it leaves white margins that a reader then has to zoom past.
    pdf.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
  }

  return Buffer.from(await pdf.save());
}

/**
 * Scales to fit, never up.
 *
 * A page smaller than the maximum is left alone: enlarging it would add nothing
 * a reader cannot do themselves and would make the file claim a resolution it
 * does not have.
 */
function fit(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };

  const scale = maxEdge / longest;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}
