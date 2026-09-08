import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { toXlsx } from './xlsx';

/**
 * Writing the `.xlsx` a bookkeeper opens.
 *
 * Read back with the same library, which is the only honest way to assert
 * anything about a zip of XML — and what is asserted is our *use* of it rather
 * than its own behaviour: which cells are text, which are numbers, and that an
 * employee reference of `0042` is still `0042` at the other end.
 */
describe('writing a workbook', () => {
  const readBack = async (buffer: Buffer) => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    return workbook.worksheets[0]!;
  };

  it('keeps a reference with a leading zero as text', async () => {
    /*
     * The whole reason this exists beside CSV. A CSV opened in Excel turns
     * `0042` into the number 42, and the bookkeeper's system then cannot match
     * the employee — silently, on one row in forty.
     */
    const sheet = await readBack(await toXlsx([['Employee ID'], ['0042']]));

    expect(sheet.getCell('A2').value).toBe('0042');
    expect(typeof sheet.getCell('A2').value).toBe('string');
  });

  it('keeps a number a number when the caller passes one', async () => {
    // A column somebody wants to sum in Excel has to arrive as numbers, which
    // is why the caller decides rather than this function guessing.
    const sheet = await readBack(await toXlsx([['Hours'], [7.5]]));

    expect(sheet.getCell('A2').value).toBe(7.5);
  });

  it('leaves an empty cell empty rather than writing "undefined"', async () => {
    const sheet = await readBack(
      await toXlsx([
        ['A', 'B'],
        ['x', undefined],
      ]),
    );

    // What a naive join produces, and what a regulator then reads.
    expect(sheet.getCell('B2').value).toBeNull();
  });

  it('freezes the header so it survives scrolling', async () => {
    const sheet = await readBack(await toXlsx([['Name'], ['Ana']]));

    // A payroll export is scrolled through by a person, and a header that
    // disappears at row thirty is a column somebody has to count back to.
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    expect(sheet.getRow(1).font?.bold).toBe(true);
  });

  it('does not freeze a row that is not a header', async () => {
    const sheet = await readBack(await toXlsx([['Ana', '7.50']], { header: false }));

    // Read back as null rather than as an empty array — the same looseness in
    // ExcelJS's own types that makes `columns` null on an empty sheet.
    expect(sheet.views?.[0]?.state).not.toBe('frozen');
  });

  it('names the tab, so the file says what it is', async () => {
    const sheet = await readBack(await toXlsx([['x']], { sheetName: 'February payroll' }));

    expect(sheet.name).toBe('February payroll');
  });

  it('sizes columns to their content, within reason', async () => {
    const sheet = await readBack(
      await toXlsx([['Short', 'A very much longer heading than the other one'.repeat(3)]]),
    );

    expect(sheet.getColumn(1).width).toBeGreaterThanOrEqual(8);
    // Capped, because one long cell — a list of clock event ids, say — must not
    // push every other column off the screen.
    expect(sheet.getColumn(2).width).toBeLessThanOrEqual(40);
  });

  it('writes a workbook with no rows in it rather than failing', async () => {
    // A period nobody worked is a real answer, and an export that threw would
    // send somebody looking for a fault that is not there.
    const sheet = await readBack(await toXlsx([]));

    expect(sheet.rowCount).toBe(0);
  });
});
