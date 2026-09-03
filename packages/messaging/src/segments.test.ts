import { describe, expect, it } from 'vitest';
import { countSegments } from './segments';

describe('countSegments', () => {
  it('fits 160 plain characters in one message', () => {
    expect(countSegments('a'.repeat(160))).toMatchObject({ segments: 1, encoding: 'gsm' });
    expect(countSegments('a'.repeat(161))).toMatchObject({ segments: 2 });
  });

  it('loses characters to the header once a message is split', () => {
    // 153 rather than 160 per part: the six bytes that say which part this is.
    expect(countSegments('a'.repeat(306)).segments).toBe(2);
    expect(countSegments('a'.repeat(307)).segments).toBe(3);
  });

  it('halves the capacity for one diacritic', () => {
    const plain = countSegments('Buna ziua, va rugam trimiteti extrasul de cont. '.repeat(2));
    const proper = countSegments('Bună ziua, vă rugăm trimiteți extrasul de cont. '.repeat(2));

    // The whole reason this function exists: a single `ă` changes the alphabet
    // for the entire message.
    expect(plain.encoding).toBe('gsm');
    expect(proper.encoding).toBe('unicode');
    expect(proper.segments).toBeGreaterThan(plain.segments);
  });

  it('names the characters that made it expensive', () => {
    const counted = countSegments('Bună ziua');

    // "Your ă is doubling the cost" is something a person can act on. "This
    // message is unicode" is not.
    expect(counted.offenders).toEqual(['ă']);
  });

  it('charges twice for the characters that cost twice', () => {
    // The extension table: each is an escape plus the character.
    expect(countSegments('{'.repeat(80)).segments).toBe(1);
    expect(countSegments('{'.repeat(81)).segments).toBe(2);
    expect(countSegments('{'.repeat(81)).encoding).toBe('gsm');
  });

  it('says how much room is left', () => {
    expect(countSegments('a'.repeat(100)).remaining).toBe(60);
    expect(countSegments('ă'.repeat(50)).remaining).toBe(20);
  });

  it('counts an emoji as the one character a person sees', () => {
    // A surrogate pair is two code units and one character; charging for two
    // would be right for a provider and wrong for everybody reading the screen.
    const counted = countSegments('👍');
    expect(counted.characters).toBe(1);
    expect(counted.encoding).toBe('unicode');
  });

  it('charges nothing for nothing', () => {
    expect(countSegments('')).toMatchObject({ segments: 0, characters: 0, remaining: 160 });
  });

  it('prices the shipped copy the way a provider will', () => {
    const ro = 'Popescu SRL: încă lipsesc Extras de cont. Le puteți trimite aici: https://d.ro/l/x';
    const hu = 'Popescu SRL: még hiányzik Bankszámlakivonat. Itt küldheti el: https://d.ro/l/x';

    /*
     * Two segments, and that is the honest answer.
     *
     * A message that names a document and carries a link is around eighty
     * characters before the firm's name goes in, and one diacritic caps a
     * segment at seventy. The alternative is stripping the diacritics from
     * somebody's language to save a penny; the product does not do that, so it
     * charges the ledger for what it actually sent.
     */
    expect(countSegments(ro).segments).toBe(2);
    expect(countSegments(hu).segments).toBe(2);
    expect(countSegments(ro).offenders).toContain('î');
  });
});
