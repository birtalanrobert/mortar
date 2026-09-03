import Papa from 'papaparse';

/**
 * Reading and writing the CSV files a spreadsheet actually produces.
 *
 * **Pure, and deliberately tiny.** No database, no framework, no Node built-ins
 * — a console previewing an upload before it happens has to run this in a
 * browser. That is also why it is not in `@birtalanrobert/files`, which carries
 * S3, virus scanning and PDF assembly: a page that wants to read twelve rows
 * should not pull in an object store.
 *
 * Both directions are here because both have the same hard-won details, and
 * both were written badly at least once before this package existed.
 */

export interface ReadOptions {
  /**
   * The separator, when it is known. Detected from the file when it is not.
   *
   * Detection matters more than it sounds: every locale using a comma as the
   * decimal separator gets semicolon-separated files out of Excel, still called
   * CSV. Honouring commas *and* semicolons at once — which is the obvious
   * shortcut — splits a field reading `screen cracked; battery dead` into two
   * and shifts every column after it, silently.
   */
  readonly delimiter?: string;
}

/**
 * Rows of cells, from a file's text.
 *
 * Blank lines are dropped and the byte-order mark Excel writes is stripped —
 * left in place it becomes part of the first header, so a column called `phone`
 * arrives as something that looks identical and matches nothing.
 */
export function parseCsv(text: string, options: ReadOptions = {}): string[][] {
  const parsed = Papa.parse<string[]>(text, {
    delimiter: options.delimiter ?? '',
    skipEmptyLines: 'greedy',
  });

  return parsed.data;
}

export interface WriteOptions {
  readonly delimiter?: string;
  /**
   * Whether to prefix a byte-order mark. On by default.
   *
   * Excel decides a file's encoding by looking at it, and a UTF-8 file with no
   * mark is read as the system code page — so `Ioană` opens as `IoanÄƒ` for
   * exactly the people whose names have diacritics. The mark is three bytes
   * that make the difference between a usable export and a support ticket.
   *
   * Turn it off when the reader is a program rather than a person.
   */
  readonly byteOrderMark?: boolean;
}

/**
 * A file, from rows of values.
 *
 * Quoting is not optional and not conditional: a value containing the
 * delimiter, a quote or a line break has to be quoted, and getting that wrong
 * shifts every column after it without any error anywhere. `null` and
 * `undefined` become empty cells rather than the strings "null" and
 * "undefined", which is what a naive join produces and what a regulator then
 * reads.
 */
export function toCsv(
  rows: ReadonlyArray<ReadonlyArray<string | number | boolean | null | undefined>>,
  options: WriteOptions = {},
): string {
  /*
   * Line endings are CRLF, which RFC 4180 specifies and Excel expects — a file
   * with bare newlines opens as one long line in some versions. Left to the
   * library rather than set here, because that is already its default and a
   * second opinion in this file would be one more thing to keep in step.
   */
  const body = Papa.unparse(
    rows.map((row) => row.map((cell) => (cell === null || cell === undefined ? '' : cell))),
    { delimiter: options.delimiter ?? ',' },
  );

  return options.byteOrderMark === false ? body : `\ufeff${body}`;
}

/**
 * The same, from objects and a column order.
 *
 * The order is given rather than taken from the first object's keys: key order
 * is an accident of construction, and a report whose columns move between runs
 * is a report nobody can build a spreadsheet against.
 */
export function toCsvFrom<T extends Record<string, unknown>>(
  columns: ReadonlyArray<{ key: keyof T & string; heading: string }>,
  rows: readonly T[],
  options: WriteOptions = {},
): string {
  return toCsv(
    [
      columns.map((column) => column.heading),
      ...rows.map((row) =>
        columns.map((column) => {
          const value = row[column.key];
          return value === null || value === undefined ? '' : String(value);
        }),
      ),
    ],
    options,
  );
}
