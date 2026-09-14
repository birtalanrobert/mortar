import { describe, expect, it } from 'vitest';
import { checkMapping, readRows, type FieldSpec } from './mapping';

const FIELDS: FieldSpec[] = [
  { field: 'code', required: true, explains: 'the product code', example: 'BER-05' },
  { field: 'name', required: true, explains: 'the product name' },
  { field: 'price', required: true, explains: 'the price per pack', example: '47,99' },
  { field: 'orderable', required: false, explains: 'whether it can be ordered' },
  { field: 'from', required: false, explains: 'the date the price takes effect' },
];

const HEADER = ['Cod', 'Denumire', 'Pret', 'Activ', 'Valabil de la'];

const MAPPING = {
  code: 'Cod',
  name: 'Denumire',
  price: 'Pret',
  orderable: 'Activ',
  from: 'Valabil de la',
};

describe('checking a mapping before anything runs', () => {
  it('accepts a mapping that covers every required field', () => {
    expect(checkMapping(FIELDS, MAPPING, HEADER)).toEqual([]);
  });

  it('names the missing field in the words the wizard shows', () => {
    const { price, ...without } = MAPPING;
    void price;

    expect(checkMapping(FIELDS, without, HEADER)).toEqual([
      { field: 'price', says: 'Say which column holds the price per pack.' },
    ]);
  });

  it('says nothing about an optional field nobody mapped', () => {
    const { orderable, from, ...without } = MAPPING;
    void orderable;
    void from;

    expect(checkMapping(FIELDS, without, HEADER)).toEqual([]);
  });

  it('lists the columns the file does have when one is named wrongly', () => {
    const problems = checkMapping(FIELDS, { ...MAPPING, price: 'Preț' }, HEADER);

    expect(problems[0]?.says).toContain('no column called "Preț"');
    expect(problems[0]?.says).toContain('Cod, Denumire, Pret, Activ, Valabil de la');
  });

  it('matches a column whatever its case and spacing', () => {
    /* Exports differ between runs of the same system, let alone between two. */
    expect(checkMapping(FIELDS, { ...MAPPING, code: '  cod  ' }, HEADER)).toEqual([]);
  });
});

describe('reading rows', () => {
  const read = (rows: string[][], conventions = {}) =>
    readRows({ header: HEADER, rows, mapping: MAPPING, conventions });

  it('numbers a row by its line in the file, header included', () => {
    const rows = read([
      ['BER-05', 'Ursus 0.5', '2.99', 'da', '2026-01-01'],
      ['TOM-25', 'Rosii', '17.50', 'nu', '2026-01-01'],
    ]);

    /* A report that says "row 1 842" is one somebody can act on. */
    expect(rows.map((row) => row.line)).toEqual([2, 3]);
  });

  it('drops rows that are entirely blank', () => {
    /* A spreadsheet saved with a thousand empty rows below the data is the
     * ordinary case rather than the exception. */
    const rows = read([['BER-05', 'Ursus', '2.99', 'da', ''], ['', '', '', '', ''], []]);

    expect(rows).toHaveLength(1);
  });

  it('reads a comma decimal when the file is told it writes one', () => {
    const [row] = read([['BER-05', 'Ursus', '47,99', 'da', '']], { decimal: ',' });

    expect(row?.decimal('price')).toBe('47.99');
    expect(row?.problems).toEqual([]);
  });

  it('strips the thousands separator before the decimal one, not after', () => {
    /*
     * The other order turns `1.234,56` into `1.234.56` and then into nothing
     * anybody can parse — and the failure is a rejected row rather than a wrong
     * number, which is the good half of getting it wrong.
     */
    const [row] = read([['BER-05', 'Ursus', '1.234,56', 'da', '']], {
      decimal: ',',
      thousands: '.',
    });

    expect(row?.decimal('price')).toBe('1234.56');
  });

  it('reads a space-grouped number, which is how half of Europe writes one', () => {
    const [row] = read([['BER-05', 'Ursus', '1 234,56', 'da', '']], {
      decimal: ',',
      thousands: ' ',
    });

    expect(row?.decimal('price')).toBe('1234.56');
  });

  it('returns a decimal as a string, never as a number', () => {
    /*
     * The whole point. A float here is the bug this module exists to avoid, and
     * `0.1 + 0.2` reaching an invoice is how it shows up.
     */
    const [row] = read([['BER-05', 'Ursus', '0.1', 'da', '']]);

    expect(row?.decimal('price')).toBe('0.1');
    expect(typeof row?.decimal('price')).toBe('string');
  });

  it('reads a trailing minus and a parenthesised negative', () => {
    /* Both are unambiguous, both come out of older systems, and both would
     * otherwise be rejected as "not a number". */
    const rows = read([
      ['A', 'One', '12.50-', '', ''],
      ['B', 'Two', '(12.50)', '', ''],
    ]);

    expect(rows[0]?.decimal('price')).toBe('-12.50');
    expect(rows[1]?.decimal('price')).toBe('-12.50');
  });

  it('rejects a value the conventions cannot read, quoting it back', () => {
    const [row] = read([['BER-05', 'Ursus', '4-7,9-9', 'da', '']], { decimal: ',' });

    expect(row?.decimal('price')).toBeNull();
    expect(row?.problems).toEqual([
      {
        line: 2,
        field: 'price',
        says: '"4-7,9-9" is not a number this file\'s conventions can read.',
      },
    ]);
  });

  it('records a problem for a required field left blank', () => {
    const [row] = read([['', 'Ursus', '2.99', 'da', '']]);

    expect(row?.required('code')).toBe('');
    expect(row?.problems[0]).toMatchObject({ line: 2, field: 'code' });
  });

  it('reads the boolean conventions of both markets', () => {
    const rows = read([
      ['A', 'One', '1', 'da', ''],
      ['B', 'Two', '1', 'nu', ''],
      ['C', 'Three', '1', 'igen', ''],
      ['D', 'Four', '1', 'nem', ''],
      ['E', 'Five', '1', 'Y', ''],
    ]);

    expect(rows.map((row) => row.boolean('orderable'))).toEqual([true, false, true, false, true]);
  });

  it('takes the file’s own words for yes and no when it has its own', () => {
    const [row] = read([['A', 'One', '1', 'aktív', '']], { truthy: ['aktív'], falsy: ['inaktív'] });

    expect(row?.boolean('orderable')).toBe(true);
  });

  it('rejects a boolean it has never been told about', () => {
    const [row] = read([['A', 'One', '1', 'maybe', '']]);

    expect(row?.boolean('orderable')).toBeNull();
    expect(row?.problems[0]?.says).toContain('neither yes nor no');
  });

  it('reads the date formats these systems actually write', () => {
    const cases = [
      { value: '2026-09-14', date: 'iso' },
      { value: '14.09.2026', date: 'DD.MM.YYYY' },
      { value: '14/09/2026', date: 'DD/MM/YYYY' },
      { value: '09/14/2026', date: 'MM/DD/YYYY' },
      { value: '20260914', date: 'YYYYMMDD' },
    ] as const;

    for (const { value, date } of cases) {
      const [row] = read([['A', 'One', '1', '', value]], { date });
      expect(row?.date('from'), `${value} as ${date}`).toBe('2026-09-14');
    }
  });

  it('refuses a date that matches the shape and is not a day', () => {
    /* `31.02.2026` passes every regular expression anybody would write. */
    const [row] = read([['A', 'One', '1', '', '31.02.2026']], { date: 'DD.MM.YYYY' });

    expect(row?.date('from')).toBeNull();
    expect(row?.problems[0]?.says).toContain('not a date in the DD.MM.YYYY format');
  });

  it('applies a prefix, which is what a re-coded catalogue needs', () => {
    /*
     * A distributor who adds a branch prefix to every code overnight would
     * otherwise produce a diff of forty thousand deletions and forty thousand
     * creations. The mapping absorbs it without a code change.
     */
    const [row] = readRows({
      header: HEADER,
      rows: [['05', 'Ursus', '2.99', 'da', '']],
      mapping: { ...MAPPING, code: { column: 'Cod', prefix: 'BER-' } },
    });

    expect(row?.required('code')).toBe('BER-05');
  });

  it('upper-cases a code where the file is inconsistent about it', () => {
    const [row] = readRows({
      header: HEADER,
      rows: [['ber-05', 'Ursus', '2.99', 'da', '']],
      mapping: { ...MAPPING, code: { column: 'Cod', case: 'upper' } },
    });

    expect(row?.text('code')).toBe('BER-05');
  });

  it('gives an unmapped optional field an empty answer rather than an error', () => {
    const [row] = readRows({
      header: HEADER,
      rows: [['BER-05', 'Ursus', '2.99', 'da', '']],
      mapping: { code: 'Cod', name: 'Denumire', price: 'Pret' },
    });

    expect(row?.text('orderable')).toBe('');
    expect(row?.boolean('orderable')).toBeNull();
    expect(row?.problems).toEqual([]);
  });

  it('lets the product record a problem of its own against a row', () => {
    const [row] = read([['BER-05', 'Ursus', '2.99', 'da', '']]);
    row?.reject('code', 'No product has that code.');

    expect(row?.problems).toEqual([{ line: 2, field: 'code', says: 'No product has that code.' }]);
  });

  it('counts lines from a header that is not on line one', () => {
    /* Two header rows and a title above them is what an Excel export looks
     * like when a person made it. */
    const rows = readRows({
      header: HEADER,
      rows: [['BER-05', 'Ursus', '2.99', 'da', '']],
      mapping: MAPPING,
      headerLine: 3,
    });

    expect(rows[0]?.line).toBe(4);
  });
});
