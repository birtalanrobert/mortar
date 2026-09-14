import writeXlsxFile, { type Cell as SheetCell } from 'write-excel-file/node';
import readXlsxFile, { readSheet } from 'read-excel-file/node';

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
 * ## Why these libraries
 *
 * `write-excel-file` writes and `read-excel-file` reads — the same author, both
 * MIT, and between them a dependency tree of five MIT packages. The obvious
 * alternative, ExcelJS, reaches an *unlicensed* transitive dependency through
 * its reading path (`unzipper` → `binary` → `buffers`, which declares no
 * licence at all), and a product that ships has no rights to code nobody has
 * granted rights to.
 *
 * The reading half was left out when this was written, on the grounds that it
 * was a licence problem bought for a capability with no consumer. It has a
 * consumer now: project 04 takes a distributor's catalogue in whatever shape
 * their system exports, and a workbook is one of the five shapes — while
 * projects 03, 05, 07, 08, 09, 10 and 12 all import a spreadsheet somebody
 * already has, because re-keying it by hand at signup is where a trial dies.
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

/**
 * The rows of a workbook, as text.
 *
 * **Every cell comes back a string, and that is the contract**, not a
 * limitation. Excel stores a guess about what each cell *is*, made by whichever
 * program wrote the file and whichever locale it ran under — and a price that
 * arrives as the number 1234.56 has already been read under a convention
 * nobody declared. A mapping decides how to read a value (project 04's §5.13
 * calls the decimal separator the most expensive character in a file); this
 * hands over what is written and lets that decision be made once, explicitly,
 * where it can be previewed.
 *
 * The exception is a date, because a date cell holds a serial number rather
 * than text and there is nothing to hand over. It comes back as `YYYY-MM-DD`,
 * which is the one format no locale reinterprets.
 */
export async function readXlsx(file: Buffer, options: ReadXlsxOptions = {}): Promise<string[][]> {
  const rows = (await readSheet(file, options.sheet ?? 1)) as unknown as Array<
    Array<string | number | boolean | Date | null>
  >;

  return rows.map((row) => row.map(asText));
}

export interface ReadXlsxOptions {
  /**
   * Which tab, by name or by 1-based position. The first when absent.
   *
   * A name rather than only a number, because an export whose tab is called
   * `Sheet1` in one month and `Preturi` in the next is the ordinary case, and
   * so is a workbook where the data is on the third tab behind two of notes.
   */
  readonly sheet?: string | number;
}

/** The tabs in a workbook, so a mapping screen can offer them. */
export async function sheetsIn(file: Buffer): Promise<string[]> {
  const workbook = (await readXlsxFile(file)) as unknown as Array<{ sheet: string }>;

  return workbook.map((one) => one.sheet);
}

function asText(cell: string | number | boolean | Date | null): string {
  if (cell === null || cell === undefined) return '';

  /*
   * A date is the one cell with nothing to hand over: the file holds a serial
   * number, and any text form is this function's invention. ISO is the one
   * nobody's locale reinterprets, and it is what every date convention in a
   * mapping can be told to expect.
   */
  if (cell instanceof Date) return cell.toISOString().slice(0, 10);

  return String(cell);
}
