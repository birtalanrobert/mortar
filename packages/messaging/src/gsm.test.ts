import { describe, expect, it } from 'vitest';
import { countSegments } from './segments';
import { transliterateToGsm } from './gsm';

describe('transliterateToGsm', () => {
  /**
   * The case this was written for.
   *
   * A Romanian cake shop's own name, in a message it sends a hundred times a
   * week. `ă` is not in the GSM alphabet, so it moves the *whole* message to
   * UCS-2 and cuts capacity from 160 characters to 70 — the shop pays twice for
   * every message because of one letter in its own name.
   */
  it('halves the cost of a Romanian shop’s name', () => {
    const name = 'Cofetăria Mierla';

    expect(countSegments(`${name}: comanda ta este gata.`).encoding).toBe('unicode');

    const safe = transliterateToGsm(name);

    expect(safe.text).toBe('Cofetaria Mierla');
    expect(safe.changed).toBe(true);
    expect(countSegments(`${safe.text}: comanda ta este gata.`).encoding).toBe('gsm');
  });

  it('handles the letters that cost the most', () => {
    /* Romanian comma-below and Hungarian double acute, the two expensive sets. */
    expect(transliterateToGsm('Șerban Țugui').text).toBe('Serban Tugui');
    /*
     * Both rules in one word: `ő` and `ű` are converted because they are not in
     * the alphabet, and the `ö` beside them is kept because it is.
     */
    expect(transliterateToGsm('Győző Bűvös').text).toBe('Gyozo Buvös');
    expect(transliterateToGsm('Łódź').text).toBe('Lodz');
    expect(transliterateToGsm('Đorđe').text).toBe('Dorde');
  });

  /**
   * The mistake a naive "strip every accent" makes.
   *
   * `é`, `ü`, `à`, `ñ` and `Ö` are **in** the GSM alphabet and cost one place
   * each. Removing their marks damages a French or German name to save nothing
   * at all — so they are left exactly as they were.
   */
  it('leaves alone the marks that are already free', () => {
    const french = 'Café Rüdesheim Ñuñoa à Göteborg';

    expect(countSegments(french).encoding).toBe('gsm');

    const safe = transliterateToGsm(french);

    expect(safe.text).toBe(french);
    expect(safe.changed).toBe(false);
  });

  /**
   * **Never silently dropped.**
   *
   * A Bulgarian shop's name has no faithful Latin equivalent, and a function
   * that removed what it could not convert would send that shop's customers a
   * message from nobody. Kept, and reported, so the product can say "this still
   * costs double" rather than claiming a saving it did not make.
   */
  it('keeps what it cannot convert, and says so', () => {
    const safe = transliterateToGsm('Сладкарница Мечта');

    expect(safe.text).toBe('Сладкарница Мечта');
    expect(safe.untranslatable).toContain('С');
    expect(countSegments(safe.text).encoding).toBe('unicode');
  });

  it('reports an emoji rather than eating it', () => {
    const safe = transliterateToGsm('Ready 🎂');

    expect(safe.text).toBe('Ready 🎂');
    expect(safe.untranslatable).toEqual(['🎂']);
  });

  it('tidies the punctuation a word processor introduces', () => {
    /* Pasted from a document, and none of it is in the GSM alphabet. */
    const safe = transliterateToGsm('“Ana’s cake” – ready…');

    expect(safe.text).toBe('"Ana\'s cake" - ready...');
    expect(countSegments(safe.text).encoding).toBe('gsm');
  });

  it('leaves an already-plain message untouched', () => {
    const plain = 'Your order KDF-29T is ready for collection.';
    const safe = transliterateToGsm(plain);

    expect(safe.text).toBe(plain);
    expect(safe.changed).toBe(false);
    expect(safe.untranslatable).toEqual([]);
  });

  it('does not touch the extended characters, which fit at two places each', () => {
    /* `{`, `}` and `€` cost two places but are GSM — changing them saves nothing. */
    const safe = transliterateToGsm('{total} is 20€');

    expect(safe.text).toBe('{total} is 20€');
    expect(safe.changed).toBe(false);
  });

  it('is idempotent, so applying it twice changes nothing more', () => {
    const once = transliterateToGsm('Cofetăria Mierlă Győr');
    const twice = transliterateToGsm(once.text);

    expect(twice.text).toBe(once.text);
    expect(twice.changed).toBe(false);
  });

  it('handles an empty string', () => {
    expect(transliterateToGsm('')).toEqual({ text: '', changed: false, untranslatable: [] });
  });
});
