import writeXlsxFile, { type Cell as SheetCell } from 'write-excel-file/node';

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
 *
 * ## Why this library
 *
 * `write-excel-file` writes and does not read, and its whole dependency tree is
 * one MIT package. The obvious alternative — ExcelJS — reaches an *unlicensed*
 * transitive dependency through its reading path (`unzipper` → `binary` →
 * `buffers`, which declares no licence at all), and a product that ships has no
 * rights to code nobody has granted rights to. Writing is all this needs; the
 * reading half was buying a licence problem for a capability with no consumer.
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

type Cell = string | number | boolean | null | undefined;

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
  rows: ReadonlyArray<ReadonlyArray<Cell>>,
  options: XlsxOptions = {},
): Promise<Buffer> {
  const withHeader = options.header !== false && rows.length > 0;

  const sheet: SheetCell[][] = rows.map((row, index) =>
    row.map((cell): SheetCell => {
      /*
       * An empty cell is `null`, not an object with a null value.
       *
       * The same choice `toCsv` makes: `null` and `undefined` become empty
       * cells rather than the strings "null" and "undefined", which is what a
       * naive join produces and what a regulator then reads.
       */
      if (cell === null || cell === undefined) return null;

      /*
       * The type travels with the cell.
       *
       * Left to the library to infer, a string of digits is a candidate for
       * becoming a number again — which is the exact trip this file exists to
       * survive. Saying `String` for a string is not redundant here; it is the
       * whole point.
       */
      const bold = withHeader && index === 0 ? { fontWeight: 'bold' as const } : {};

      if (typeof cell === 'number') return { value: cell, type: Number, ...bold };
      if (typeof cell === 'boolean') return { value: cell, type: Boolean, ...bold };

      return { value: cell, type: String, ...bold };
    }),
  );

  /*
   * Columns wide enough to read, and no wider.
   *
   * A file whose every column shows `########` is one the recipient has to fix
   * before they can check it, which is exactly the friction this export exists
   * to remove. Capped, because one long cell — a list of clock event ids, say —
   * must not push every other column off the screen.
   */
  const columns = (rows[0] ?? []).map((_, index) => {
    let widest = 0;
    for (const row of rows) {
      const cell = row[index];
      if (cell === null || cell === undefined) continue;
      widest = Math.max(widest, String(cell).length);
    }
    return { width: Math.min(Math.max(widest + 2, 8), 40) };
  });

  return writeXlsxFile(sheet, {
    // `sheet`, not `sheetName`: the option is named for the tab it labels.
    sheet: options.sheetName ?? 'Export',
    ...(columns.length > 0 ? { columns } : {}),
    // Frozen, so the header survives scrolling to row thirty.
    ...(withHeader ? { stickyRowsCount: 1 } : {}),
  }).toBuffer();
}
