import sharp from 'sharp';
import { detectType } from '../detect';

/** The formats a derivative may be written in. */
export type ImageFormat = 'avif' | 'webp' | 'jpeg' | 'png';

const CONTENT_TYPES: Record<ImageFormat, string> = {
  avif: 'image/avif',
  webp: 'image/webp',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

/**
 * Defaults chosen for photographs on a phone, which is what these products
 * receive: a plate of food, a damaged screen, a sofa in somebody's front room.
 *
 * AVIF is roughly half the bytes of JPEG at the same perceived quality and
 * costs an order of magnitude more CPU to encode — which is the right trade in
 * a worker that encodes once and serves thousands of times, and the wrong one
 * anywhere on a request path.
 */
const DEFAULT_QUALITY: Record<ImageFormat, number> = {
  avif: 50,
  webp: 75,
  jpeg: 78,
  png: 100,
};

/** What the products actually upload. Anything else is refused by name. */
const RASTER = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/tiff']);

export interface DerivativeSpec {
  /**
   * The product's own name for this size — `thumb`, `card`, `full`.
   *
   * Not a width, because a width is a rendering decision that changes and a
   * name is a contract. A stored key of `card` survives the day somebody
   * decides cards are 720 wide rather than 640; a key of `640` does not.
   */
  name: string;
  /** Target width in pixels. Never enlarged beyond the original. */
  width: number;
  /** Overrides the render's formats for this size alone. */
  formats?: readonly ImageFormat[];
}

export interface RenderOptions {
  /** The responsive set, in the product's own vocabulary. */
  sizes: readonly DerivativeSpec[];
  /** Written for every size unless the size overrides it. */
  formats?: readonly ImageFormat[];
  quality?: Partial<Record<ImageFormat, number>>;
  /**
   * `blur` adds a tiny data URI as well as the dominant colour.
   *
   * Both exist to stop layout shift; the difference is what fills the box while
   * the photograph arrives. A colour is free and always right; a blur is a few
   * hundred bytes inline and reads as the photograph appearing rather than
   * replacing something.
   */
  placeholder?: 'colour' | 'blur';
  /**
   * The decompression-bomb guard, in pixels.
   *
   * A 100KB PNG can decode to 40 gigabytes, which is a worker killed by the
   * kernel rather than an error anybody sees. The default is generous enough
   * for a full-frame camera and far below what it takes to hurt.
   */
  maxPixels?: number;
}

export interface Derivative {
  name: string;
  format: ImageFormat;
  contentType: string;
  width: number;
  height: number;
  bytes: Buffer;
}

export interface RenderedImage {
  /** The source's dimensions **after** orientation, which is what a page needs. */
  width: number;
  height: number;
  /** What the upload actually was, read from its bytes rather than its name. */
  contentType: string;
  /** `#rrggbb`, for the box the photograph will land in. */
  dominantColour: string;
  /** A `data:` URI, when `placeholder: 'blur'` was asked for. */
  placeholder?: string;
  derivatives: Derivative[];
}

export class UnsupportedImageError extends Error {
  constructor(readonly contentType: string | undefined) {
    super(
      contentType
        ? `${contentType} is not an image this pipeline can read.`
        : 'That file is not an image.',
    );
    this.name = 'UnsupportedImageError';
  }
}

/**
 * A venue's four-megabyte photograph, turned into what a phone should download.
 *
 * Eight of the seventeen products take pictures from people who are not
 * thinking about the web: a couple uploading twelve-megapixel photographs from
 * a wedding, a repair shop photographing a cracked screen, a venue
 * photographing a plate. **None of them will ever be asked to resize
 * anything**, so this is where that promise is kept.
 *
 * Four things happen here and each is a defect somewhere that skipped it:
 *
 * 1. **Orientation is applied.** A phone stores a portrait photograph as a
 *    landscape one plus an EXIF flag saying "turn this". Software that ignores
 *    the flag shows the picture on its side, and software that reads the
 *    dimensions without applying it reserves a landscape box for a portrait
 *    picture — which is the layout shift the placeholder was meant to prevent.
 * 2. **Metadata is dropped**, and with it the GPS coordinates of the customer's
 *    front room. This is sharp's default rather than a call made here; there is
 *    a test asserting it, because the day somebody adds `withMetadata()` to
 *    keep a colour profile, the coordinates come back with it.
 * 3. **Nothing is enlarged.** A four-hundred-pixel photograph asked for a
 *    sixteen-hundred-pixel derivative stays four hundred wide. The alternative
 *    spends bytes on blur.
 * 4. **The dominant colour is measured**, so the space is filled before the
 *    picture arrives rather than flashing white.
 *
 * The sizes are the product's, deliberately: a thumbnail in a repair queue and
 * a full-bleed photograph on a wedding microsite have nothing in common but the
 * machinery.
 */
export async function renderImage(input: Buffer, options: RenderOptions): Promise<RenderedImage> {
  const detected = detectType(input);
  if (!detected || !RASTER.has(detected.contentType)) {
    /*
     * Read from the bytes, never from a filename or a header.
     *
     * The important refusal is not a text file called `photo.jpg` — it is an
     * SVG, which libvips will happily rasterise and which is a document format
     * with a scripting engine and a URL loader in it.
     */
    throw new UnsupportedImageError(detected?.contentType);
  }

  const limitInputPixels = options.maxPixels ?? 100_000_000;
  const formats = options.formats ?? (['avif', 'webp', 'jpeg'] as const);
  const quality = { ...DEFAULT_QUALITY, ...options.quality };

  const metadata = await sharp(input, { limitInputPixels }).metadata();
  const sourceWidth = metadata.width ?? 0;
  const sourceHeight = metadata.height ?? 0;

  /*
   * `metadata()` reports the stored dimensions, not the displayed ones.
   *
   * EXIF orientations 5 to 8 all involve a quarter turn, so a portrait
   * photograph from a phone arrives as `4032 × 3024` plus a flag. Everything
   * downstream — the `width` and `height` attributes that reserve the box, the
   * decision about which derivatives are worth generating — has to use the
   * turned dimensions, and this swap is the whole of that correction.
   */
  const turned = (metadata.orientation ?? 1) >= 5;
  const width = turned ? sourceHeight : sourceWidth;
  const height = turned ? sourceWidth : sourceHeight;

  const [dominantColour, placeholder, derivatives] = await Promise.all([
    dominant(input, limitInputPixels),
    options.placeholder === 'blur' ? blur(input, limitInputPixels) : Promise.resolve(undefined),
    renderAll(input, { sizes: options.sizes, formats, quality, limitInputPixels, width }),
  ]);

  return {
    width,
    height,
    contentType: detected.contentType,
    dominantColour,
    placeholder,
    derivatives,
  };
}

async function renderAll(
  input: Buffer,
  options: {
    sizes: readonly DerivativeSpec[];
    formats: readonly ImageFormat[];
    quality: Record<ImageFormat, number>;
    limitInputPixels: number;
    width: number;
  },
): Promise<Derivative[]> {
  const wanted: Array<{ spec: DerivativeSpec; format: ImageFormat }> = [];

  for (const spec of options.sizes) {
    for (const format of spec.formats ?? options.formats) {
      wanted.push({ spec, format });
    }
  }

  /*
   * Sequential, not `Promise.all`.
   *
   * sharp already uses a thread pool per operation, and encoding six AVIFs at
   * once on a four-core worker does not finish sooner — it finishes at the same
   * time while holding six decoded images in memory, which is how a worker
   * handling a wedding's upload batch gets killed by the kernel.
   */
  const derivatives: Derivative[] = [];

  for (const { spec, format } of wanted) {
    derivatives.push(
      await one(input, {
        spec,
        format,
        quality: options.quality[format],
        limitInputPixels: options.limitInputPixels,
      }),
    );
  }

  return derivatives;
}

async function one(
  input: Buffer,
  options: {
    spec: DerivativeSpec;
    format: ImageFormat;
    quality: number;
    limitInputPixels: number;
  },
): Promise<Derivative> {
  const { spec, format, quality } = options;

  const pipeline = sharp(input, { limitInputPixels: options.limitInputPixels })
    // No argument: turn it the way the EXIF flag says, then forget the flag.
    .rotate()
    /*
     * Everything leaves as sRGB.
     *
     * A photograph from a recent phone is often Display P3, and a browser
     * handed those numbers with no profile attached renders them as sRGB —
     * which is why the greens come back looking radioactive. Converting is the
     * fix; attaching the profile instead would mean carrying metadata this
     * pipeline has just promised to drop.
     */
    .toColourspace('srgb')
    .resize({ width: spec.width, withoutEnlargement: true });

  const encoded =
    format === 'avif'
      ? pipeline.avif({ quality })
      : format === 'webp'
        ? pipeline.webp({ quality })
        : format === 'jpeg'
          ? pipeline.jpeg({ quality, mozjpeg: true })
          : pipeline.png();

  const { data, info } = await encoded.toBuffer({ resolveWithObject: true });

  return {
    name: spec.name,
    format,
    contentType: CONTENT_TYPES[format],
    width: info.width,
    height: info.height,
    bytes: data,
  };
}

/** `#rrggbb` for the box the photograph will land in. */
async function dominant(input: Buffer, limitInputPixels: number): Promise<string> {
  /*
   * Measured on a small copy.
   *
   * The histogram of a twelve-megapixel photograph and of the same photograph
   * at 128 pixels wide give the same answer to within a shade, and one of them
   * takes a hundred times as long. The colour fills a box for a few hundred
   * milliseconds; it does not need to be exact.
   */
  const small = await sharp(input, { limitInputPixels })
    .rotate()
    .toColourspace('srgb')
    .resize({ width: 128, withoutEnlargement: true })
    .toBuffer();

  const { dominant: colour } = await sharp(small).stats();

  return `#${[colour.r, colour.g, colour.b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

/** A few hundred bytes of blurred photograph, inline. */
async function blur(input: Buffer, limitInputPixels: number): Promise<string> {
  const bytes = await sharp(input, { limitInputPixels })
    .rotate()
    .toColourspace('srgb')
    .resize({ width: 16, withoutEnlargement: true })
    // Quality this low is the point: it is stretched over the whole box and
    // blurred by the browser, and every byte is in the HTML rather than a
    // request.
    .webp({ quality: 30 })
    .toBuffer();

  return `data:image/webp;base64,${bytes.toString('base64')}`;
}
