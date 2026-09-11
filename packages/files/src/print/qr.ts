import QRCode from 'qrcode';

export type ErrorCorrection = 'L' | 'M' | 'Q' | 'H';

/** One row of dark modules, as a start and a length. See `qrRuns`. */
export interface QrRun {
  readonly x: number;
  readonly y: number;
  readonly length: number;
}

export interface QrMatrix {
  /** Modules per side, including the quiet zone this does **not** add. */
  readonly size: number;
  readonly dark: (x: number, y: number) => boolean;
}

/**
 * The module grid for a payload, without deciding how it is drawn.
 *
 * A matrix rather than an image, because the two consumers of this want
 * different things from it and neither wants a bitmap: a PDF draws it as
 * rectangles, and a test asserts on the modules.
 *
 * `M` by default — a quarter of the code may be lost and still read. `L` is
 * tempting because it makes the code smaller, and wrong for anything printed:
 * a table tent picks up a thumbprint and a ring of coffee within a week, and
 * the whole point of the artefact is that it still scans.
 */
export function qrMatrix(text: string, level: ErrorCorrection = 'M'): QrMatrix {
  const code = QRCode.create(text, { errorCorrectionLevel: level });
  const { size, data } = code.modules;

  return {
    size,
    dark: (x, y) => x >= 0 && y >= 0 && x < size && y < size && data[y * size + x] === 1,
  };
}

/**
 * The dark modules merged into horizontal runs.
 *
 * **Vector, not a bitmap, and this is what makes that cheap.** A QR drawn as
 * one rectangle per module is up to a thousand operations and a PDF a reader
 * takes a moment over; merged into runs it is a couple of hundred, and it stays
 * sharp at whatever resolution the printer actually has. A rasterised QR scaled
 * to a 60 mm square on a 1200 dpi printer is a blurred one, and a blurred QR at
 * the third attempt is a guest who gives up and asks for a menu.
 *
 * Runs rather than a full rectangle-merge: the gain from the second dimension is
 * small, and the code that finds it is the kind nobody can check by reading.
 */
export function qrRuns(matrix: QrMatrix): QrRun[] {
  const runs: QrRun[] = [];

  for (let y = 0; y < matrix.size; y += 1) {
    let start = -1;

    for (let x = 0; x <= matrix.size; x += 1) {
      const dark = x < matrix.size && matrix.dark(x, y);

      if (dark && start === -1) start = x;
      else if (!dark && start !== -1) {
        runs.push({ x: start, y, length: x - start });
        start = -1;
      }
    }
  }

  return runs;
}

/**
 * The white margin a scanner needs around a code, in modules.
 *
 * Four is the specification's minimum and is not decoration: a code printed
 * hard against a coloured panel is one a phone finds slowly or not at all, and
 * the design that causes it looks tidier than the one that works.
 */
export const QUIET_ZONE = 4;
