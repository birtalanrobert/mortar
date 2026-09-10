import { describe, expect, it } from 'vitest';
import { Ticket, wrap } from './escpos';

/**
 * What a printer actually receives.
 *
 * Bytes rather than a rendered picture, because bytes are what a printer
 * accepts and every one of these assertions is a mistake that has printed
 * wrong in somebody's kitchen: a style left on, a cut that took the last three
 * items with it, a Romanian dish name full of question marks.
 */
const bytes = (ticket: Ticket) => [...ticket.render()];

/** The text a printer would put on paper, past the initialisation bytes. */
const printed = (ticket: Ticket) =>
  Buffer.from(ticket.render())
    .subarray(5)
    .toString('latin1')
    .split('\n')
    .filter((line) => line !== '');

describe('a ticket', () => {
  it('initialises the printer before anything else', () => {
    const out = bytes(new Ticket().line('Mici'));

    /*
     * `ESC @`, first, always. A printer holds whatever the last ticket left it
     * in — and the classic symptom is every ticket after a heading printing
     * double height until somebody power-cycles it.
     */
    expect(out.slice(0, 2)).toEqual([0x1b, 0x40]);
  });

  it('sets a character table that has Romanian and Hungarian in it', () => {
    const out = bytes(new Ticket().line('x'));

    // 16 is Windows-1250. The American default most printers boot into turns
    // `ș` into `?`, which on a kitchen ticket is a dish nobody can read.
    expect(out.slice(2, 5)).toEqual([0x1b, 0x74, 16]);
  });

  it('prints accented text as the printer’s own bytes', () => {
    const out = bytes(new Ticket().line('Ciorbă'));

    // `ă` is 0xe3 in this table. Getting it wrong is not cosmetic: it is a
    // ticket a cook glances at and misreads.
    expect(out).toContain(0xe3);
    expect(out).not.toContain(0x3f);
  });

  it('prints a question mark for something it genuinely cannot render', () => {
    const out = bytes(new Ticket().line('日本'));

    /*
     * Visibly wrong on purpose. Dropping the character silently would produce a
     * name that looks almost right; a `?` is something somebody notices and
     * asks about.
     */
    expect(out.filter((byte) => byte === 0x3f)).toHaveLength(2);
  });

  it('turns a style off again after using it', () => {
    const out = bytes(new Ticket().heading('TABLE 7').line('Mici'));

    // On, then off. A builder that only turns styles on leaves the next ticket
    // in whatever state this one ended in.
    expect(out).toContain(0x30);
    const on = out.indexOf(0x30);
    expect(out.slice(on + 1)).toContain(0x00);
  });

  it('feeds the paper past the blade before cutting', () => {
    const out = bytes(new Ticket().line('Mici').cut());

    /*
     * The blade sits a couple of centimetres above the print head. A cut with
     * no feed takes the last three lines with it — on a kitchen ticket, the
     * last three items.
     */
    const feed = out.findIndex((byte, index) => byte === 0x1b && out[index + 1] === 0x64);
    const cut = out.findIndex((byte, index) => byte === 0x1d && out[index + 1] === 0x56);

    expect(feed).toBeGreaterThan(-1);
    expect(cut).toBeGreaterThan(feed);
  });

  it('lays a label against a value, filling between', () => {
    // Past the five bytes of initialisation, which every ticket starts with.
    const line = printed(new Ticket({ width: 32 }).columns('Ciorbă de burtă', '24,50'))[0];

    // The shape every receipt line has, and the one every product otherwise
    // reimplements with `padEnd`.
    expect(line).toContain('24,50');
    expect(line).toHaveLength(32);
  });

  it('shortens a label rather than pushing the value off the paper', () => {
    const line = printed(
      new Ticket({ width: 20 }).columns('A dish with an extremely long name', '199,00'),
    )[0];

    // The price is the thing that must survive: a receipt whose total ran off
    // the edge is one nobody can settle.
    expect(line).toContain('199,00');
    expect(line).toHaveLength(20);
  });
});

describe('wrapping to the paper', () => {
  it('breaks on spaces', () => {
    expect(wrap('one two three four', 9)).toEqual(['one two', 'three', 'four']);
  });

  it('breaks a word longer than the paper rather than letting it run off', () => {
    // A URL on a receipt, or a dish name somebody typed in capitals.
    expect(wrap('supercalifragilistic', 8)).toEqual(['supercal', 'ifragili', 'stic']);
  });

  it('keeps the lines somebody deliberately wrote', () => {
    expect(wrap('first\nsecond', 20)).toEqual(['first', 'second']);
  });

  it('keeps an indent, and keeps it on what wraps', () => {
    /*
     * Leading spaces are structure. A kitchen ticket indents a modifier under
     * its dish, and flush left it reads as belonging to the *next* dish — which
     * is how somebody's allergy ends up on the wrong plate.
     *
     * The continuation line matters as much as the first: a modifier long
     * enough to wrap that slides back to the margin has the same problem one
     * line later.
     */
    expect(wrap('   no onions at all please', 14)).toEqual([
      '   no onions',
      '   at all',
      '   please',
    ]);
  });

  it('prefers the text to the indent when the paper is too narrow', () => {
    // An indent as wide as the paper leaves nowhere to print. The words win:
    // they are the part somebody has to read.
    expect(wrap('        hello', 6)).toEqual(['hello']);
  });

  it('never truncates', () => {
    /*
     * The end of a line on a kitchen ticket is where the modifiers are, and
     * "Mici de casă — fără ceapă" cut at the paper's width is a plate that
     * comes back.
     */
    const wrapped = wrap('Mici de casă fără ceapă', 12);
    expect(wrapped.join(' ')).toContain('fără ceapă');
  });
});
