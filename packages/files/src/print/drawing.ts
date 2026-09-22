import { ValidationError } from '@birtalanrobert/http';

export interface DrawingOptions {
  /** Pixels across. The height follows the drawing's own aspect ratio. */
  readonly width: number;
  /** `#rrggbb` behind it. Defaults to white, because this goes on paper. */
  readonly background?: string;
  /** Refuses anything larger, in pixels. A guard rather than a setting. */
  readonly maxPixels?: number;
}

/**
 * A drawing **your own code produced**, turned into pixels for a PDF.
 *
 * pdf-lib embeds PNG and JPEG and nothing else, so a vector drawing destined
 * for paper has to be rasterised somewhere — and the only place in this
 * monorepo holding an image pipeline is here.
 *
 * **It is deliberately not the upload path, and the difference is the whole
 * point.** `renderImage` refuses SVG on purpose: an SVG is a document format
 * with a scripting engine and a URL loader in it, and one arriving from a
 * customer is a file that can read the server's disk. This function exists for
 * the opposite case — a string a product *generated* one line earlier, from its
 * own data, never having touched a network. Passing an uploaded file to it
 * undoes that refusal, so the name says whose drawing it is and this paragraph
 * says what happens if you lie about it.
 *
 * Rendered at the size it will be printed at rather than at some larger size
 * and scaled: a seat map is small circles, and a rasteriser given the final
 * dimensions places them on pixel boundaries instead of blurring each one.
 *
 * **`sharp` is loaded when this is called, not when the module is imported.**
 * It is an optional peer dependency, and the rest of this subpath — the QR
 * codes, the printable cards — has never needed it: a product printing table
 * tents should not have to install a native image pipeline because a barrel
 * mentions one. A static import here made it required for everybody, which is
 * the defect this shape exists to avoid.
 */
export async function renderDrawing(svg: string, options: DrawingOptions): Promise<Buffer> {
  const width = Math.round(options.width);

  if (!Number.isFinite(width) || width < 1 || width > 4_000) {
    throw new ValidationError(
      [{ field: 'width', message: 'A drawing is between 1 and 4000 pixels wide.' }],
      'That drawing width is not printable.',
    );
  }

  if (!/^\s*<svg[\s>]/i.test(svg)) {
    /* Checked rather than assumed: libvips will try to read whatever it is
       handed, and the error it produces for a stray HTML page says nothing a
       caller can act on. */
    throw new ValidationError(
      [{ field: 'svg', message: 'That is not an SVG document.' }],
      'That drawing could not be read.',
    );
  }

  const sharp = await pipeline();

  return (
    sharp(Buffer.from(svg), {
      /* A generated drawing is small. The ceiling is here so a bug that computes
       a viewBox of a million metres fails instead of exhausting the process. */
      limitInputPixels: options.maxPixels ?? 20_000_000,
      density: 96,
    })
      .resize({ width, fit: 'inside', withoutEnlargement: false })
      /*
       * Flattened onto a background rather than left transparent.
       *
       * A PDF viewer composites transparency against whatever is behind it, which
       * on a printed sheet is the paper and on a screen is sometimes black — so a
       * map drawn in dark grey disappears for half the people who open it.
       */
      .flatten({ background: options.background ?? '#ffffff' })
      .png({ compressionLevel: 9 })
      .toBuffer()
  );
}

/**
 * The image pipeline, or a refusal that names what is missing.
 *
 * The message matters: a bare `Cannot find module 'sharp'` thrown from inside a
 * dependency is a stack trace nobody traces back to an optional peer they were
 * never told they needed.
 */
async function pipeline(): Promise<typeof import('sharp')> {
  try {
    return (await import('sharp')).default;
  } catch {
    throw new Error(
      "Drawing a plan needs the optional peer dependency 'sharp'. Add it to this service.",
    );
  }
}
