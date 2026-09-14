# @birtalanrobert/csv

Reading and writing the CSV files a spreadsheet actually produces.

```ts
import { parseCsv, toCsv, toCsvFrom } from '@birtalanrobert/csv';
```

Pure and deliberately tiny — no database, no framework, no Node built-ins,
because a console previewing an upload has to run this in a browser. That is
also why it is not part of `@birtalanrobert/files`, which carries S3, virus
scanning and PDF assembly: a page reading twelve rows should not pull in an
object store.

## Reading

```ts
parseCsv(text); // delimiter detected from the file
parseCsv(text, { delimiter: ';' }); // when it is known
```

Detection is the point. Every locale that uses a comma as the decimal separator
gets semicolon-separated files out of Excel, still called CSV — and the obvious
shortcut, honouring commas _and_ semicolons at once, splits a field reading
`screen cracked; battery dead` into two and shifts every column after it,
silently. That bug is why this package exists rather than being written a third
time.

Blank lines are dropped, and the byte-order mark Excel writes is stripped: left
in place it becomes part of the first header, so a column called `phone` arrives
as something that looks identical and matches nothing.

## Writing

```ts
toCsv([['Popescu, Ana', 'said "yes"']]);
toCsvFrom([{ key: 'when', heading: 'When' }], rows);
```

Quoting is not optional: a value containing the delimiter, a quote or a line
break shifts every column after it if it is not quoted, and nothing anywhere
reports an error. `null` and `undefined` become empty cells rather than the
strings a naive join produces.

A byte-order mark is written by default. Excel decides a file's encoding by
looking at it, so a UTF-8 file without one is read as the system code page and
`Ioană` opens as `IoanÄƒ` — for exactly the people whose names have diacritics.
Pass `byteOrderMark: false` when the reader is a program rather than a person.

`toCsvFrom` takes the column order rather than reading it off the first object:
key order is an accident of construction, and a report whose columns move
between runs is one nobody can build a spreadsheet against.

## Mapping columns onto fields

`@birtalanrobert/csv/mapping` is a separate entry point, and separate on
purpose: parsing a file is one problem — delimiters, encodings, the byte-order
mark Excel writes — and deciding that column four is the price is a different
one. A mapping UI previews the second in a browser without ever holding the
file.

Four projects in this catalogue ask for the same thing in four different words:
a price-list wizard, a payroll export profile saved per bookkeeper, a
spreadsheet import of years of candidates, and an ERP feed whose layout is
configured rather than coded. This is what they share. What stays with the
product every time is which field means what, what a valid row is, and what to
do about a bad one.

```ts
import { checkMapping, readRows, type FieldSpec } from '@birtalanrobert/csv/mapping';

const FIELDS: FieldSpec[] = [
  { field: 'code', required: true, explains: 'the product code', example: 'BER-05' },
  { field: 'price', required: true, explains: 'the price per pack', example: '47,99' },
];

// Before anything runs, while somebody is looking at a preview.
checkMapping(FIELDS, { code: 'Cod' }, ['Cod', 'Pret']);
// [{ field: 'price', says: 'Say which column holds the price per pack.' }]

const rows = readRows({
  header: ['Cod', 'Pret'],
  rows: [['BER-05', '1.234,56']],
  mapping: { code: 'Cod', price: 'Pret' },
  conventions: { decimal: ',', thousands: '.' },
});

rows[0].required('code'); // 'BER-05'
rows[0].decimal('price'); // '1234.56' — a string, always
rows[0].line; // 2, counting the header as line 1
rows[0].problems; // []
```

**Conventions are configuration, never guessed.** `1.234,56` and `1,234.56` are
the same number under two conventions and both arrive from the same country;
read under the wrong one a price is wrong by a factor of a thousand, **and it
passes every validation a sensible person writes** — it is a number, it is
positive, it is in range. Guessing from the first few rows works until the first
file where every value happens to be round.

**A decimal comes back as a string.** A float here is the bug the whole module
exists to avoid. The consumer feeds it to its own decimal type, which is the
only thing that should ever hold a price.

**A problem carries a line number**, counting the header as line 1, so a report
says "row 1 842" and somebody can go and look at row 1 842. Products add their
own with `row.reject(field, says)`, so that "no product has that code" and "that
is not a number" arrive in one list.
