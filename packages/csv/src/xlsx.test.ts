import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { toXlsx } from './xlsx';

/**
 * Writing the `.xlsx` a bookkeeper opens.
 *
 * Read back by unzipping the file and looking at the XML, which is what an
 * `.xlsx` is. That is deliberate rather than lazy: pulling in a second
 * spreadsheet library to assert what the first one wrote would prove the two
 * agree, and the questions here are about the *file* — is `0042` still text, is
 * a number still a number, is the header frozen.
 *
 * `fflate` is already in the tree as this writer's only dependency, so the
 * reader costs nothing.
 */
describe('writing a workbook', () => {
  /** The sheet's XML, and the shared string table it points into. */
  const open = async (buffer: Buffer) => {
    const files = unzipSync(new Uint8Array(buffer));
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml']!);
    const shared = files['xl/sharedStrings.xml']
      ? [...strFromU8(files['xl/sharedStrings.xml']).matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map(
          (match) => match[1]!,
        )
      : [];

    /** One cell's value, resolved through the shared string table. */
    const cell = (reference: string): { value: string; shared: boolean } | null => {
      const match = new RegExp(`<c r="${reference}"([^>]*)>(?:<v>([^<]*)</v>)?`).exec(sheet);
      if (!match) return null;

      const isShared = /t="s"/.test(match[1] ?? '');
      const raw = match[2] ?? '';

      return { value: isShared ? (shared[Number(raw)] ?? '') : raw, shared: isShared };
    };

    return { sheet, cell };
  };

  it('keeps a reference with a leading zero as text', async () => {
    /*
     * The whole reason this exists beside CSV. A CSV opened in Excel turns
     * `0042` into the number 42, and the bookkeeper's system then cannot match
     * the employee — silently, on one row in forty.
     */
    const { cell } = await open(await toXlsx([['Employee ID'], ['0042']]));

    expect(cell('A2')).toEqual({ value: '0042', shared: true });
  });

  it('keeps a number a number when the caller passes one', async () => {
    // A column somebody wants to sum in Excel has to arrive as numbers, which
    // is why the caller decides rather than this function guessing.
    const { cell } = await open(await toXlsx([['Hours'], [7.5]]));

    expect(cell('A2')).toEqual({ value: '7.5', shared: false });
  });

  it('leaves an empty cell empty rather than writing "undefined"', async () => {
    const { sheet } = await open(
      await toXlsx([
        ['A', 'B'],
        ['x', undefined],
      ]),
    );

    // What a naive join produces, and what a regulator then reads.
    expect(sheet).not.toContain('undefined');
    expect(sheet).not.toContain('null');
  });

  it('freezes the header so it survives scrolling', async () => {
    const { sheet } = await open(await toXlsx([['Name'], ['Ana']]));

    // A payroll export is scrolled through by a person, and a header that
    // disappears at row thirty is a column somebody has to count back to.
    expect(sheet).toContain('<pane');
    expect(sheet).toContain('ySplit="1"');
  });

  it('does not freeze a row that is not a header', async () => {
    const { sheet } = await open(await toXlsx([['Ana', '7.50']], { header: false }));

    expect(sheet).not.toContain('ySplit');
  });

  it('names the tab, so the file says what it is', async () => {
    const buffer = await toXlsx([['x']], { sheetName: 'February payroll' });
    const workbook = strFromU8(unzipSync(new Uint8Array(buffer))['xl/workbook.xml']!);

    expect(workbook).toContain('February payroll');
  });

  it('sizes columns to their content, within reason', async () => {
    const { sheet } = await open(
      await toXlsx([['Short', 'A very much longer heading than the other one'.repeat(3)]]),
    );

    const widths = [...sheet.matchAll(/width="([\d.]+)"/g)].map((match) => Number(match[1]));

    expect(widths[0]).toBeGreaterThanOrEqual(8);
    // Capped, because one long cell — a list of clock event ids, say — must not
    // push every other column off the screen.
    expect(Math.max(...widths)).toBeLessThanOrEqual(40);
  });

  it('writes a workbook with no rows in it rather than failing', async () => {
    // A period nobody worked is a real answer, and an export that threw would
    // send somebody looking for a fault that is not there.
    const { sheet } = await open(await toXlsx([]));

    expect(sheet).toContain('<sheetData');
  });
});
