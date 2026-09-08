import ExcelJS from 'exceljs';

/**
 * Writing the `.xlsx` a bookkeeper opens.
 *
 * **Behind a subpath, and that is the whole reason it is not in the index.**
 * The CSV side of this package is browser-safe and small; a spreadsheet writer
 * is neither, and a console counting segments on every keystroke must not be
 * shipping a zip library to do it. Only what needs Excel pays for Excel.
 *
 * ## Why not a CSV renamed
 *
 * Four of the seventeen specifications ask for Excel *beside* CSV, and the
 * reason is always the same: a CSV opened in Excel is reinterpreted on the way
 * in. An employee reference of `0042` becomes the number 42, a date column
 * becomes whatever the reader's locale thinks, and `7,50` becomes either seven
 * and a half or the text "7,50" depending on a setting nobody in the business
 * can find. An `.xlsx` says what each cell is and the file survives the trip.
 */

export interface XlsxOptions {
  /** The tab's name. Shown to whoever opens the file, so it should say what it is. */
  readonly sheetName?: string;
  /**
   * Whether the first row is a header, and should be frozen and bold.
   *
   * On by default. A payroll export is scrolled through by a person, and a
   * header row that disappears at row thirty is a column somebody has to count
   * back to.
   */
  readonly header?: boolean;
}

/**
 * A workbook, from rows of values.
 *
 * **Strings stay strings and numbers stay numbers**, which is the entire
 * contract and the reason a caller decides which it hands over. An employee
 * reference is text — `0042` is not forty-two — and hours a bookkeeper's system
 * expects with a comma are text too, because the separator is their layout's
 * decision rather than the reader's locale's. A caller wanting a column that
 * sums in Excel passes numbers and gets numbers.
 *
 * `null` and `undefined` become empty cells rather than the strings "null" and
 * "undefined" — the same choice `toCsv` makes, for the same reason.
 */
export async function toXlsx(
  rows: ReadonlyArray<ReadonlyArray<string | number | boolean | null | undefined>>,
  options: XlsxOptions = {},
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(options.sheetName ?? 'Export');

  for (const row of rows) {
    sheet.addRow(row.map((cell) => (cell === null || cell === undefined ? null : cell)));
  }

  const withHeader = options.header !== false && rows.length > 0;

  if (withHeader) {
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
  }

  /*
   * Columns wide enough to read, and no wider.
   *
   * A file whose every column shows `########` is one the recipient has to
   * fix before they can check it, which is exactly the friction this export
   * exists to remove. Capped, because one long cell — a list of clock event
   * ids, say — must not push a column off the screen.
   */
  /*
   * `columns` is *null* on a sheet with no rows, whatever the types say.
   *
   * ExcelJS declares it as an array and returns null until something has been
   * added — so an export for a period nobody worked crashed here, which is a
   * real answer failing rather than a bug in the data. Guarded rather than
   * asserted, because the honest output for an empty period is an empty file.
   */
  (sheet.columns ?? []).forEach((column, index) => {
    let widest = 0;
    for (const row of rows) {
      const cell = row[index];
      if (cell === null || cell === undefined) continue;
      widest = Math.max(widest, String(cell).length);
    }
    column.width = Math.min(Math.max(widest + 2, 8), 40);
  });

  /*
   * `Buffer.from`, because ExcelJS resolves to an `ArrayBuffer` whose type its
   * own declarations describe loosely. Converting here means every caller gets
   * something it can write to a response or a file without a cast of its own.
   */
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
