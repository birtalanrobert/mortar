/**
 * Turning the columns somebody else's system wrote into the fields a product
 * understands.
 *
 * **Pure, and separate from the reader on purpose.** Parsing a file is one
 * problem — delimiters, encodings, the byte-order mark Excel writes — and
 * deciding that column four is the price is a different one. A mapping UI
 * previews the second in a browser without ever holding the file.
 *
 * Four specifications in this catalogue ask for the same thing in four
 * different words: project 03 imports price lists with a column-mapping wizard,
 * project 07 exports payroll through a per-tenant column mapping saved per
 * bookkeeper, project 08 imports years of a recruiter's spreadsheets, and
 * project 04 makes mapping the architectural centre — the decision that
 * determines whether onboarding a new ERP layout is a support session or an
 * engineering project. This module is what they share, and the first consumer
 * was not a specification but 764 lines of working code in project 03.
 *
 * What stays with the product, every time: which field means what, what a valid
 * row is, and what to do about a bad one.
 */

/**
 * One field a product needs, and enough about it to explain itself.
 *
 * `explains` is not documentation. It is the sentence a mapping UI shows beside
 * a dropdown to a support person who has never seen this file before, and it is
 * the sentence a refusal quotes: *"Say which column holds the price per pack."*
 */
export interface FieldSpec {
  readonly field: string;
  readonly required: boolean;
  /** What it means, as a noun phrase: "the price per pack". */
  readonly explains: string;
  /** A value of the shape expected, shown beside the column preview. */
  readonly example?: string;
}

/** Where a field's value comes from, and what to do to it on the way. */
export interface ColumnMapping {
  /** The column in the file. Matched case- and space-insensitively. */
  readonly column: string;
  /** Added to the front of every value: a branch prefix, a code namespace. */
  readonly prefix?: string;
  readonly suffix?: string;
  readonly case?: 'upper' | 'lower';
}

/** Field name to the column that supplies it. */
export type Mapping = Readonly<Record<string, string | ColumnMapping>>;

/**
 * How this file writes numbers, dates and booleans.
 *
 * **Never guessed.** `1.234,56` and `1,234.56` are the same number under two
 * conventions and both arrive from the same country; read under the wrong one a
 * price is wrong by a factor of a thousand, **and it passes every validation a
 * sensible person writes** — it is a number, it is positive, it is in range.
 * Guessing from the first few rows works until the first file where every value
 * happens to be round.
 */
export interface Conventions {
  /** The character before the fractional part. Default `.`. */
  readonly decimal?: '.' | ',';
  /** The character grouping thousands, if any. Default none. */
  readonly thousands?: '.' | ',' | ' ' | "'" | '';
  /** Default `iso`, which also accepts `YYYY-M-D`. */
  readonly date?: 'iso' | 'DD.MM.YYYY' | 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'YYYYMMDD';
  /** What this file writes for true. Matched case-insensitively. */
  readonly truthy?: readonly string[];
  readonly falsy?: readonly string[];
}

const DEFAULT_TRUE = ['1', 'y', 'yes', 'true', 't', 'da', 'igen', 'ja'];
const DEFAULT_FALSE = ['0', 'n', 'no', 'false', 'f', 'nu', 'nem', 'nein'];

/** Why a mapping cannot be used against this file. */
export interface MappingProblem {
  readonly field: string;
  readonly says: string;
}

/** Why one cell of one row cannot be used. */
export interface RowProblem {
  /** The line in the file, counting the header as line 1. */
  readonly line: number;
  readonly field: string;
  readonly says: string;
}

/** One row, read through the mapping, with whatever went wrong attached. */
export interface Row {
  readonly line: number;
  readonly raw: readonly string[];
  readonly problems: readonly RowProblem[];
  /** The cell as text, trimmed. Empty string when absent or blank. */
  text: (field: string) => string;
  /** The cell as text, recording a problem when it is blank. */
  required: (field: string) => string;
  /**
   * The cell as a canonical decimal string — `1234.56` — or null when blank.
   *
   * A string rather than a number, and that is the point: a float here is the
   * bug this whole module exists to avoid. The consumer feeds it to its own
   * decimal type, which is the only thing that should ever hold a price.
   */
  decimal: (field: string) => string | null;
  integer: (field: string) => number | null;
  boolean: (field: string) => boolean | null;
  /** The cell as an ISO date — `2026-09-14` — or null when blank. */
  date: (field: string) => string | null;
  /** Records a problem of the product's own devising against this row. */
  reject: (field: string, says: string) => void;
}

const normalise = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Whether this mapping can be used against this header, and what is missing.
 *
 * **Refused here rather than at three in the morning.** A feed that cannot
 * satisfy its required fields is a configuration error, and the person who can
 * fix it is looking at a preview right now. The same check running inside a
 * scheduled job at 03:00 produces a stack trace nobody reads.
 */
export function checkMapping(
  fields: readonly FieldSpec[],
  mapping: Mapping,
  header: readonly string[],
): MappingProblem[] {
  const columns = new Set(header.map(normalise));
  const problems: MappingProblem[] = [];

  for (const spec of fields) {
    const mapped = mapping[spec.field];

    if (mapped === undefined) {
      if (spec.required) {
        problems.push({
          field: spec.field,
          says: `Say which column holds ${spec.explains}.`,
        });
      }
      continue;
    }

    const column = typeof mapped === 'string' ? mapped : mapped.column;

    if (!columns.has(normalise(column))) {
      problems.push({
        field: spec.field,
        says: `This file has no column called "${column}". It has: ${header.join(', ')}.`,
      });
    }
  }

  return problems;
}

/**
 * Reads every row through the mapping.
 *
 * Rows that are entirely blank are dropped — a spreadsheet saved with a
 * thousand empty rows below the data is the ordinary case, not the exception —
 * and **the line number is the file's**, counting the header as line 1, so that
 * a report says "row 1 842" and somebody can go and look at row 1 842.
 */
export function readRows(input: {
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly mapping: Mapping;
  readonly conventions?: Conventions;
  /** The line the header was on. Default 1. */
  readonly headerLine?: number;
}): Row[] {
  const conventions = input.conventions ?? {};
  const headerLine = input.headerLine ?? 1;
  const index = new Map(input.header.map((column, at) => [normalise(column), at]));

  const locate = (field: string): { at: number; mapped: ColumnMapping } | undefined => {
    const mapped = input.mapping[field];
    if (mapped === undefined) return undefined;

    const spec = typeof mapped === 'string' ? { column: mapped } : mapped;
    const at = index.get(normalise(spec.column));

    return at === undefined ? undefined : { at, mapped: spec };
  };

  return input.rows
    .map((raw, offset) => ({ raw, line: headerLine + offset + 1 }))
    .filter(({ raw }) => raw.some((cell) => cell.trim() !== ''))
    .map(({ raw, line }) => makeRow(raw, line, locate, conventions));
}

function makeRow(
  raw: readonly string[],
  line: number,
  locate: (field: string) => { at: number; mapped: ColumnMapping } | undefined,
  conventions: Conventions,
): Row {
  const problems: RowProblem[] = [];
  const reject = (field: string, says: string) => problems.push({ line, field, says });

  const text = (field: string): string => {
    const found = locate(field);
    if (!found) return '';

    let value = (raw[found.at] ?? '').trim();
    if (value === '') return '';

    if (found.mapped.prefix) value = `${found.mapped.prefix}${value}`;
    if (found.mapped.suffix) value = `${value}${found.mapped.suffix}`;
    if (found.mapped.case === 'upper') value = value.toUpperCase();
    if (found.mapped.case === 'lower') value = value.toLowerCase();

    return value;
  };

  const required = (field: string): string => {
    const value = text(field);
    if (value === '') reject(field, `${field} is empty, and it is needed.`);

    return value;
  };

  return {
    line,
    raw,
    problems,
    text,
    required,
    reject,

    decimal: (field) => {
      const value = text(field);
      if (value === '') return null;

      const normalised = toDecimalString(value, conventions);
      if (normalised === undefined) {
        reject(field, `"${value}" is not a number this file's conventions can read.`);
        return null;
      }

      return normalised;
    },

    integer: (field) => {
      const value = text(field);
      if (value === '') return null;

      const normalised = toDecimalString(value, conventions);
      if (normalised === undefined || !/^-?\d+$/.test(normalised)) {
        reject(field, `"${value}" is not a whole number.`);
        return null;
      }

      return Number(normalised);
    },

    boolean: (field) => {
      const value = text(field).toLowerCase();
      if (value === '') return null;

      const truthy = conventions.truthy ?? DEFAULT_TRUE;
      const falsy = conventions.falsy ?? DEFAULT_FALSE;

      if (truthy.some((one) => one.toLowerCase() === value)) return true;
      if (falsy.some((one) => one.toLowerCase() === value)) return false;

      reject(field, `"${value}" is neither yes nor no in this file's conventions.`);
      return null;
    },

    date: (field) => {
      const value = text(field);
      if (value === '') return null;

      const iso = toIsoDate(value, conventions.date ?? 'iso');
      if (!iso) {
        reject(field, `"${value}" is not a date in the ${conventions.date ?? 'iso'} format.`);
        return null;
      }

      return iso;
    },
  };
}

/**
 * A canonical `1234.56` from whatever this file writes.
 *
 * The thousands separator is stripped **first**, and only then is the decimal
 * separator replaced. Doing it the other way round turns `1.234,56` into
 * `1.234.56` and then into nothing anybody can parse.
 */
function toDecimalString(value: string, conventions: Conventions): string | undefined {
  const decimalSeparator = conventions.decimal ?? '.';
  const thousands = conventions.thousands ?? '';

  let cleaned = value.replace(/\s/g, thousands === ' ' ? '' : '');

  if (thousands && thousands !== ' ') {
    cleaned = cleaned.split(thousands).join('');
  }

  if (decimalSeparator !== '.') {
    cleaned = cleaned.split(decimalSeparator).join('.');
  }

  /*
   * A trailing minus is how several older systems write a negative, and a
   * parenthesised value is how a spreadsheet does. Both are unambiguous and
   * both would otherwise be rejected as "not a number".
   */
  if (/^\(.*\)$/.test(cleaned)) cleaned = `-${cleaned.slice(1, -1)}`;
  if (/^\d+(\.\d+)?-$/.test(cleaned)) cleaned = `-${cleaned.slice(0, -1)}`;

  return /^-?\d+(\.\d+)?$/.test(cleaned) ? cleaned : undefined;
}

function toIsoDate(value: string, format: NonNullable<Conventions['date']>): string | undefined {
  const pad = (part: string) => part.padStart(2, '0');
  const build = (y: string, m: string, d: string): string | undefined => {
    const iso = `${y}-${pad(m)}-${pad(d)}`;
    /*
     * Round-tripped through Date, because `2026-02-31` matches every pattern a
     * regular expression can express and is not a day.
     */
    const parsed = new Date(`${iso}T00:00:00Z`);

    return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso
      ? undefined
      : iso;
  };

  if (format === 'iso') {
    const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value.trim());
    return match ? build(match[1]!, match[2]!, match[3]!) : undefined;
  }

  if (format === 'YYYYMMDD') {
    const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value.trim());
    return match ? build(match[1]!, match[2]!, match[3]!) : undefined;
  }

  const separator = format === 'DD.MM.YYYY' ? '\\.' : '/';
  const match = new RegExp(`^(\\d{1,2})${separator}(\\d{1,2})${separator}(\\d{4})$`).exec(
    value.trim(),
  );
  if (!match) return undefined;

  return format === 'MM/DD/YYYY'
    ? build(match[3]!, match[1]!, match[2]!)
    : build(match[3]!, match[2]!, match[1]!);
}
