import { describe, expect, it } from 'vitest';
import { dialable, formatPhone, isSearchablePhone, normalisePhone } from './phone';

describe('telephone numbers', () => {
  it('treats one person’s number written four ways as one number', () => {
    /*
     * The assertion every customer lookup rests on.
     *
     * A returning customer is one field only if the lookup finds them. Miss
     * this and a business accumulates three records for one person, and "when
     * was she last in" stops being answerable.
     */
    const written = ['+40 722 123 456', '0722123456', '0722-123-456', '40722123456'];

    expect(new Set(written.map((one) => normalisePhone(one, 'RO'))).size).toBe(1);
    expect(normalisePhone('0722123456', 'RO')).toBe('40722123456');
  });

  it('reads a Hungarian number with its two-digit trunk prefix', () => {
    expect(normalisePhone('06 20 123 4567', 'HU')).toBe('36201234567');
    expect(normalisePhone('+36201234567', 'HU')).toBe('36201234567');
  });

  it('keeps a number it cannot place rather than refusing it', () => {
    /*
     * A business serving a customer with a foreign number must not be
     * blocked. The cost of getting this wrong is that the customer is not
     * matched to a previous visit — recoverable and visible. Refusing is not.
     */
    expect(normalisePhone('00 44 7700 900123', 'RO')).toBe('00447700900123');
    expect(normalisePhone('118', 'RO')).toBe('118');
  });

  it('does not confuse the two markets’ numbers', () => {
    // A Romanian mobile and a Hungarian one both start `0`, and both are nine
    // national digits. Normalising against the wrong market must not silently
    // produce a plausible number in it.
    expect(normalisePhone('0722123456', 'RO')).toBe('40722123456');
    expect(normalisePhone('+40722123456', 'HU')).toBe('40722123456');
  });

  it('is empty for nothing', () => {
    expect(normalisePhone('', 'RO')).toBe('');
    expect(normalisePhone('   ', 'RO')).toBe('');
    expect(normalisePhone('---', 'RO')).toBe('');
  });

  describe('worth searching for', () => {
    it('waits until there is enough to match on', () => {
      // Offering to look up `07` wastes a second of a thirty-second budget and
      // returns everybody.
      expect(isSearchablePhone('07', 'RO')).toBe(false);
      expect(isSearchablePhone('0722', 'RO')).toBe(false);
      expect(isSearchablePhone('0722123456', 'RO')).toBe(true);
    });
  });

  describe('read back to a person', () => {
    it('shows a number in the shape its owner writes it', () => {
      // `40722123456` is a string a customer has to decode to recognise as
      // their own, and it appears on the receipt and the status page.
      expect(formatPhone('40722123456', 'RO')).toBe('0722 123 456');
      expect(formatPhone('36201234567', 'HU')).toBe('06 20 123 4567');
    });

    it('falls back to an international form for anything else', () => {
      expect(formatPhone('447700900123', 'RO')).toBe('+447700900123');
      expect(formatPhone('', 'RO')).toBe('');
    });
  });
});

describe('turning a stored number into an address', () => {
  it('adds the plus a provider needs', () => {
    /*
     * The stored form is a search key — digits only, so two spellings of one
     * number match. A provider wants E.164, and a pumping check that refuses
     * anything without a country code refuses a bare `40722123456` too: a
     * perfectly good number recorded as "not international".
     */
    expect(dialable('40722123456')).toBe('+40722123456');
    expect(dialable('+40722123456')).toBe('+40722123456');
  });

  it('refuses rather than guessing', () => {
    // A caller has to decide what to do about it, instead of sending to a
    // plus sign.
    expect(dialable('')).toBeNull();
    expect(dialable('12345')).toBeNull();
  });
});
