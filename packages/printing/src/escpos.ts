/**
 * ESC/POS, which is a protocol from 1990 that every thermal printer still
 * speaks.
 *
 * Bytes rather than a rendering library, because what a kitchen printer accepts
 * is a byte stream and every abstraction over it eventually has to be argued
 * with. What is worth having is a *builder* that makes the common mistakes
 * impossible: forgetting to reset a style so the next ticket prints double
 * height, cutting before the paper has fed past the blade, or sending a code
 * page the printer does not have and putting `?` where a Romanian venue wrote
 * `ș`.
 */

/**
 * Characters per line, which is how a thermal printer measures paper.
 *
 * A number rather than a union of the three common ones — 32 for 58mm, 42 or 48
 * for 80mm depending on the font. Printers disagree about their own width, and
 * a type that refuses the one a venue actually owns is a type somebody works
 * around rather than a type that helps.
 */
export type PaperWidth = number;

export interface RenderOptions {
  /**
   * Characters per line. 32 for 58mm paper, 42 or 48 for 80mm depending on the
   * font — printers disagree, and the venue's own printer is the authority.
   */
  readonly width?: PaperWidth;
  /**
   * The printer's character table for accented text.
   *
   * **Not cosmetic in either market.** A kitchen ticket that prints
   * `Ciorb? de burt?` is one a cook cannot read at a glance, and a receipt that
   * mangles a customer's name is one they photograph and complain about. 16 is
   * Windows-1250 (Central European: Romanian and Hungarian), 0 is the American
   * default most printers boot into.
   */
  readonly codePage?: number;
}

const ESC = 0x1b;
const GS = 0x1d;

/**
 * A ticket, built line by line and turned into bytes once.
 *
 * Every style is set *and cleared* around the text it applies to. A printer
 * holds whatever it was last told until something changes it, so a builder that
 * only turns styles on leaves the next ticket in whatever state the last one
 * ended in — the classic symptom being every ticket after a heading printing
 * double height until somebody power-cycles the printer.
 */
export class Ticket {
  private readonly parts: number[][] = [];
  private readonly width: PaperWidth;
  private readonly codePage: number;

  constructor(options: RenderOptions = {}) {
    this.width = options.width ?? 42;
    // Windows-1250 by default: both markets this programme serves write
    // accented Latin, and the American default silently drops it.
    this.codePage = options.codePage ?? 16;
  }

  /** Plain text, wrapped to the paper rather than truncated. */
  line(text = ''): this {
    for (const wrapped of wrap(text, this.width)) {
      this.parts.push([...encode(wrapped), 0x0a]);
    }

    // An empty string is a blank line, which is the caller's intent.
    if (text === '') this.parts.push([0x0a]);

    return this;
  }

  /** Bigger and bolder, for the thing somebody reads from a metre away. */
  heading(text: string): this {
    this.parts.push([ESC, 0x21, 0x30]); // double height and width
    for (const wrapped of wrap(text, Math.floor(this.width / 2))) {
      this.parts.push([...encode(wrapped), 0x0a]);
    }
    this.parts.push([ESC, 0x21, 0x00]); // and back, always

    return this;
  }

  bold(text: string): this {
    this.parts.push([ESC, 0x45, 0x01]);
    for (const wrapped of wrap(text, this.width)) {
      this.parts.push([...encode(wrapped), 0x0a]);
    }
    this.parts.push([ESC, 0x45, 0x00]);

    return this;
  }

  centred(text: string): this {
    this.parts.push([ESC, 0x61, 0x01]);
    for (const wrapped of wrap(text, this.width)) {
      this.parts.push([...encode(wrapped), 0x0a]);
    }
    this.parts.push([ESC, 0x61, 0x00]);

    return this;
  }

  /**
   * A label on the left and a value on the right, filled between.
   *
   * The shape every receipt line has, and the one every product otherwise
   * reimplements with `padEnd` and gets wrong when the label is long enough to
   * meet the value.
   */
  columns(left: string, right: string): this {
    const room = Math.max(1, this.width - right.length - 1);
    const label = left.length > room ? `${left.slice(0, room - 1)}…` : left;

    return this.line(`${label}${' '.repeat(this.width - label.length - right.length)}${right}`);
  }

  rule(character = '-'): this {
    return this.line(character.repeat(this.width));
  }

  /**
   * Feeds the paper past the blade, then cuts.
   *
   * The feed is not optional and is the mistake worth preventing: the blade sits
   * a couple of centimetres above the print head, so a cut without it takes the
   * last three lines of the ticket with it — which on a kitchen ticket is the
   * last three items.
   */
  cut(feed = 4): this {
    this.parts.push([ESC, 0x64, feed]);
    this.parts.push([GS, 0x56, 0x00]);

    return this;
  }

  /** Opens the cash drawer wired to the printer, for a counter. */
  openDrawer(): this {
    this.parts.push([ESC, 0x70, 0x00, 0x19, 0xfa]);
    return this;
  }

  /** The bytes, with the printer initialised and the code page set first. */
  render(): Buffer {
    return Buffer.from([
      ESC,
      0x40, // initialise: clear whatever the last ticket left behind
      ESC,
      0x74,
      this.codePage,
      ...this.parts.flat(),
    ]);
  }
}

/**
 * Text to bytes in the printer's character table.
 *
 * Windows-1250 for the accented Latin both markets use. A byte the table has no
 * room for becomes `?` — visibly wrong, which is the point: silently dropping
 * it produces a name that looks almost right and is not.
 */
function encode(text: string): number[] {
  return [...text].map((character) => {
    const code = character.codePointAt(0) ?? 63;
    if (code < 128) return code;

    return CP1250.get(character) ?? 63;
  });
}

/**
 * The characters Romanian and Hungarian need beyond ASCII.
 *
 * Deliberately not a full table: these are the ones that appear in a venue's
 * menu, a customer's name and a shop's terms, and a map of twenty entries is
 * something a person can check. A dependency that knows every code page would
 * be a supply-chain surface for six characters.
 */
const CP1250 = new Map<string, number>([
  ['Ă', 0xc3],
  ['ă', 0xe3],
  ['Â', 0xc2],
  ['â', 0xe2],
  ['Î', 0xcc],
  ['î', 0xec],
  ['Ș', 0x8a],
  ['ș', 0x9a],
  ['Ş', 0x8a],
  ['ş', 0x9a],
  ['Ț', 0xde],
  ['ț', 0xfe],
  ['Ţ', 0xde],
  ['ţ', 0xfe],
  ['Á', 0xc1],
  ['á', 0xe1],
  ['É', 0xc9],
  ['é', 0xe9],
  ['Í', 0xcd],
  ['í', 0xed],
  ['Ó', 0xd3],
  ['ó', 0xf3],
  ['Ö', 0xd6],
  ['ö', 0xf6],
  ['Ő', 0xd5],
  ['ő', 0xf5],
  ['Ú', 0xda],
  ['ú', 0xfa],
  ['Ü', 0xdc],
  ['ü', 0xfc],
  ['Ű', 0xdb],
  ['ű', 0xfb],
  ['€', 0x80],
]);

/**
 * Wraps at the paper's width, breaking on spaces where it can.
 *
 * Truncating instead is the tempting shortcut and the wrong one: the end of a
 * line on a kitchen ticket is where the modifiers are, and "Mici de casă — fără
 * ceapă" truncated at 42 characters is a plate somebody sends back.
 */
export function wrap(text: string, width: number): string[] {
  if (text === '') return [];

  const lines: string[] = [];

  for (const paragraph of text.split('\n')) {
    /*
     * Leading spaces are structure, and they used to be eaten.
     *
     * Splitting on `' '` turns `'   Extra sauce'` into three empty words
     * followed by the real ones, and every empty one is discarded — so an
     * indented block came out flush left. On a kitchen ticket that indentation
     * is what separates a modifier from the *next* dish's name, and losing it
     * is how a cook reads "no onions" as belonging to the wrong plate.
     *
     * Kept, and re-applied to continuation lines: a modifier long enough to
     * wrap must stay under its dish, not slide back out to the margin.
     */
    const indent = paragraph.slice(0, paragraph.length - paragraph.trimStart().length);
    const room = width - indent.length;

    // An indent as wide as the paper leaves nowhere to print. The text wins;
    // it is the part somebody has to read.
    if (room < 1) {
      lines.push(...wrap(paragraph.trimStart(), width));
      continue;
    }

    let current = '';

    for (const word of paragraph.trimStart().split(' ')) {
      if (current === '') {
        current = word;
      } else if (`${current} ${word}`.length <= room) {
        current = `${current} ${word}`;
      } else {
        lines.push(indent + current);
        current = word;
      }

      // A single word longer than the paper — a URL, a long dish name — is
      // broken rather than left to run off the edge.
      while (current.length > room) {
        lines.push(indent + current.slice(0, room));
        current = current.slice(room);
      }
    }

    lines.push(indent + current);
  }

  return lines;
}
