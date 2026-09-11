import { describe, expect, it } from 'vitest';
import { QUIET_ZONE, qrMatrix, qrRuns } from './qr';

describe('qrMatrix', () => {
  /**
   * The three finder patterns, which is how a phone works out which way up a
   * code is — and therefore the one property a drawing bug destroys. A matrix
   * transposed or flipped still looks like a QR code to a person and scans on
   * nothing.
   */
  it('puts a finder pattern in three corners and not the fourth', () => {
    const matrix = qrMatrix('https://example.com/t/ABCD');

    /*
     * The whole 7×7 block, not a handful of probes. A looser check passes on
     * the bottom-right corner of this very payload by coincidence, which is
     * the sort of test that reports a healthy matrix for a broken one.
     */
    const block = (ox: number, oy: number): string => {
      const rows: string[] = [];
      for (let y = oy; y < oy + 7; y += 1) {
        let row = '';
        for (let x = ox; x < ox + 7; x += 1) row += matrix.dark(x, y) ? '#' : '.';
        rows.push(row);
      }

      return rows.join('\n');
    };

    const FINDER = [
      '#######',
      '#.....#',
      '#.###.#',
      '#.###.#',
      '#.###.#',
      '#.....#',
      '#######',
    ].join('\n');

    expect(block(0, 0)).toBe(FINDER);
    expect(block(matrix.size - 7, 0)).toBe(FINDER);
    expect(block(0, matrix.size - 7)).toBe(FINDER);
    /* And not the fourth, which is what tells a scanner which way up it is. */
    expect(block(matrix.size - 7, matrix.size - 7)).not.toBe(FINDER);
  });

  it('grows with the payload rather than refusing it', () => {
    const short = qrMatrix('https://a.example/1');
    const long = qrMatrix(`https://a.example/${'x'.repeat(200)}`);

    expect(long.size).toBeGreaterThan(short.size);
  });

  it('reads nothing outside the grid as light', () => {
    const matrix = qrMatrix('https://example.com');

    expect(matrix.dark(-1, 0)).toBe(false);
    expect(matrix.dark(0, matrix.size)).toBe(false);
  });

  /** Four modules, the specification's minimum, and not a design decision. */
  it('states the quiet zone rather than leaving it to whoever draws', () => {
    expect(QUIET_ZONE).toBe(4);
  });
});

describe('qrRuns', () => {
  it('merges a row of dark modules into one rectangle', () => {
    const matrix = { size: 4, dark: (x: number, y: number) => y === 1 && x < 3 };

    expect(qrRuns(matrix)).toEqual([{ x: 0, y: 1, length: 3 }]);
  });

  it('closes a run that reaches the edge', () => {
    const matrix = { size: 3, dark: (_x: number, y: number) => y === 0 };

    expect(qrRuns(matrix)).toEqual([{ x: 0, y: 0, length: 3 }]);
  });

  it('keeps a gap as two runs', () => {
    const matrix = { size: 5, dark: (x: number, y: number) => y === 0 && x !== 2 };

    expect(qrRuns(matrix)).toEqual([
      { x: 0, y: 0, length: 2 },
      { x: 3, y: 0, length: 2 },
    ]);
  });

  /**
   * The point of the exercise: fewer drawing operations than dark modules, and
   * every one of them still covered exactly once.
   */
  it('covers every dark module in fewer rectangles than there are modules', () => {
    const matrix = qrMatrix('https://example.com/t/ABCD');
    const runs = qrRuns(matrix);

    let dark = 0;
    for (let y = 0; y < matrix.size; y += 1) {
      for (let x = 0; x < matrix.size; x += 1) if (matrix.dark(x, y)) dark += 1;
    }

    expect(runs.reduce((total, run) => total + run.length, 0)).toBe(dark);
    expect(runs.length).toBeLessThan(dark);
  });
});
