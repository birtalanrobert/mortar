import { describe, expect, it } from 'vitest';
import { parseCsv, toCsv, toCsvFrom } from './index';

describe('reading a file a spreadsheet produced', () => {
  it('detects the delimiter from the file', () => {
    /*
     * Every locale that uses a comma as the decimal separator gets
     * semicolon-separated files out of Excel, still called CSV.
     */
    expect(parseCsv('a;b\n1;2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseCsv('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('does not split a comma file on a semicolon inside a field', () => {
    /*
     * The bug this package exists to stop being rewritten. Honouring both
     * separators at once splits this field in two and shifts every column after
     * it, silently — the worst way to corrupt an import.
     */
    expect(parseCsv('phone,fault,model\n0722,screen cracked; battery dead,S23')).toEqual([
      ['phone', 'fault', 'model'],
      ['0722', 'screen cracked; battery dead', 'S23'],
    ]);
  });

  it('reads quoted fields containing delimiters, quotes and breaks', () => {
    expect(parseCsv('a,"b,c",d')[0]).toEqual(['a', 'b,c', 'd']);
    expect(parseCsv('a,"say ""hello""",c')[0]).toEqual(['a', 'say "hello"', 'c']);
    expect(parseCsv('a,"one\ntwo",c')[0]).toEqual(['a', 'one\ntwo', 'c']);
  });

  it('strips the mark Excel writes, which would otherwise hide in a header', () => {
    // Left in, a column called `phone` arrives as something that looks
    // identical and matches nothing.
    expect(parseCsv('\ufeffphone,name')[0]).toEqual(['phone', 'name']);
  });

  it('drops blank lines rather than returning empty rows', () => {
    expect(parseCsv('a,b\n\n1,2\n\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('writing a file a person will open', () => {
  it('quotes what has to be quoted', () => {
    /*
     * A name with a comma in it shifts every column after it if it is not
     * quoted, and nothing anywhere reports an error.
     */
    const written = toCsv([['Popescu, Ana', 'said "yes"', 'one\ntwo']], {
      byteOrderMark: false,
    });

    expect(parseCsv(written)[0]).toEqual(['Popescu, Ana', 'said "yes"', 'one\ntwo']);
  });

  it('writes empty cells for absent values, not the word "undefined"', () => {
    // What a naive join produces, and what a regulator then reads.
    expect(toCsv([['a', null, undefined, 'd']], { byteOrderMark: false })).toBe('a,,,d');
  });

  it('marks the encoding by default, because Excel guesses without it', () => {
    /*
     * A UTF-8 file with no mark is read as the system code page, so `Ioană`
     * opens as `IoanÄƒ` — for exactly the people whose names have diacritics.
     */
    expect(toCsv([['Ioană']]).charCodeAt(0)).toBe(0xfeff);
    expect(toCsv([['Ioană']], { byteOrderMark: false }).charCodeAt(0)).not.toBe(0xfeff);
  });

  it('takes the column order it is given', () => {
    // Key order is an accident of construction, and a report whose columns move
    // between runs is one nobody can build a spreadsheet against.
    const written = toCsvFrom(
      [
        { key: 'when', heading: 'When' },
        { key: 'who', heading: 'Who' },
      ],
      [{ who: 'Ana', when: '2026-09-03' }],
      { byteOrderMark: false },
    );

    // CRLF, which is what RFC 4180 specifies and what Excel expects. A file
    // with bare newlines opens as one long line in some versions.
    expect(written).toBe('When,Who\r\n2026-09-03,Ana');
  });

  it('round-trips through its own reader', () => {
    const rows = [
      ['reference', 'customer', 'note'],
      ['0903-AB12', 'Popescu, Ana', 'screen cracked; battery dead'],
    ];

    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
});
