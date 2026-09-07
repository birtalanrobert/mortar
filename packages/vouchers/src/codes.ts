/**
 * The code printed on a gift voucher.
 *
 * Somebody reads this off a card and says it down a telephone, or the person at
 * the desk types it from a photograph. Everything about it follows from that:
 * no characters that look like one another, nothing needing a shift key, and
 * short enough to say out loud.
 *
 * **Not a secret in the cryptographic sense, and not treated as one.** A
 * voucher is a bearer instrument — whoever has the card may spend it — so what
 * protects it is the rate limit in front of the lookup and the fact that it is
 * worth a fixed amount at one business. Twelve characters of this alphabet is
 * 32^12, which is enough that guessing is not a strategy.
 *
 * **Crockford's base32**, which is not a preference: its excluded letters (I,
 * L, O, U) and its substitutions (I and L read as 1, O as 0) are the mistakes
 * people actually make reading a code aloud, worked out by somebody who
 * measured it. U is excluded as well, which spares a business printing a
 * voucher that spells something.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Four groups of three, because that is how people read a number back. */
export const CODE_GROUPS = 4;
export const CODE_GROUP_LENGTH = 3;

export const codeAlphabet = (): string => ALPHABET;

/**
 * What somebody typed, as the code it was meant to be.
 *
 * Uppercased, punctuation dropped, and the three substitutions applied. A
 * customer reading a code off a photograph should not be told their voucher
 * does not exist because they typed a letter O.
 */
export function normaliseCode(typed: string): string {
  const bare = typed
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');

  const groups: string[] = [];

  for (let index = 0; index < bare.length; index += CODE_GROUP_LENGTH) {
    groups.push(bare.slice(index, index + CODE_GROUP_LENGTH));
  }

  return groups.join('-');
}

/** Whether a normalised code could be one of ours at all. */
export function looksLikeCode(code: string): boolean {
  const bare = code.replace(/-/g, '');

  return (
    bare.length === CODE_GROUPS * CODE_GROUP_LENGTH &&
    [...bare].every((letter) => ALPHABET.includes(letter))
  );
}
