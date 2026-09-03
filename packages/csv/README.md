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
