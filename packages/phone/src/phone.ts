/**
 * The telephone number, as the durable identity of a customer.
 *
 * A returning customer is one field, and the lookup either finds them or it
 * does not. That makes *matching* the thing that has to be right — the same
 * person typed as `0722 123 456`, `+40722123456` and `0722-123-456` has to be
 * one customer, or a business accumulates three of them and "when was she last
 * in" stops being answerable.
 *
 * So a number is stored twice: as it was typed, and normalised. The normalised
 * form is what is unique and what is searched; the typed form is what is shown
 * back, because a customer recognises their own number in the shape they write
 * it.
 */

/**
 * Countries these products are sold in, and what a local number means there.
 *
 * `groups` is how the country writes a number down, which is not decoration:
 * a customer checking the number on their receipt is pattern-matching against
 * the shape they know, and `0722123456` reads as a different number from
 * `0722 123 456` to the person who owns it.
 */
const DIALLING = {
  RO: { code: '40', trunk: '0', nationalLength: 9, groups: [3, 3, 3], trunkSpace: false },
  HU: { code: '36', trunk: '06', nationalLength: 9, groups: [2, 3, 4], trunkSpace: true },
} as const;

export type Market = keyof typeof DIALLING;

export const MARKETS = Object.keys(DIALLING) as readonly Market[];

export function isMarket(value: string): value is Market {
  return value in DIALLING;
}

/**
 * Reduces a number to the form two entries of the same number share.
 *
 * `+40 722 123 456`, `0722123456` and `0722-123-456` all normalise to
 * `40722123456`. Anything that cannot be understood as a number in the given
 * market is returned digits-only rather than rejected — a business taking a
 * call from abroad must not be blocked, and a booking that cannot be taken is a
 * worse outcome than a number that only ever matches itself.
 */
export function normalisePhone(input: string, market: Market): string {
  const trimmed = input.trim();
  if (!trimmed) return '';

  const international = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return '';

  // Written with a +, so it already says which country it is in.
  if (international) return digits;

  const { code, trunk, nationalLength } = DIALLING[market];

  // Already carries the country code, written without the plus.
  if (digits.startsWith(code) && digits.length === code.length + nationalLength) return digits;

  // A national number: drop the trunk prefix and prepend the country code.
  if (digits.startsWith(trunk) && digits.length === trunk.length + nationalLength) {
    return code + digits.slice(trunk.length);
  }

  // A bare national number with no trunk prefix, as a diallable string on a
  // handset frequently is.
  if (digits.length === nationalLength) return code + digits;

  /*
   * Something else: a short code, a foreign number typed without a plus, a
   * typo. Kept as digits rather than refused.
   *
   * A business cannot be stopped from taking a booking because a number looks
   * unusual, and the cost of being wrong here is that the customer is not
   * matched to a previous visit — recoverable, and visible. Refusing is not.
   */
  return digits;
}

/**
 * Whether a number is plausible enough to be worth matching on.
 *
 * Deliberately not "valid". Nothing here refuses a booking; this decides
 * whether the console offers to look the customer up, and offering to search
 * for `07` wastes a second of a thirty-second budget.
 */
export function isSearchablePhone(input: string, market: Market): boolean {
  const normalised = normalisePhone(input, market);
  return normalised.length >= DIALLING[market].nationalLength;
}

/**
 * The number as a person reads it back.
 *
 * Shown on a receipt, a confirmation or a status page, where `40722123456` is
 * a string a customer has to decode to recognise as their own.
 */
export function formatPhone(normalised: string, market: Market): string {
  const { code, trunk, groups, trunkSpace } = DIALLING[market];

  if (!normalised.startsWith(code)) return normalised ? `+${normalised}` : '';

  const national = normalised.slice(code.length);

  const parts: string[] = [];
  let rest = national;
  for (const size of groups) {
    if (!rest) break;
    parts.push(rest.slice(0, size));
    rest = rest.slice(size);
  }
  // Anything the pattern did not account for is kept rather than dropped: a
  // number silently shortened on a receipt is worse than one grouped oddly.
  if (rest) parts.push(rest);

  // Romania joins the trunk to the first group — `0722 123 456` — and Hungary
  // separates it — `06 20 123 4567`. Both are how the number is printed on a
  // business card in that country, and neither is a preference.
  return `${trunk}${trunkSpace ? ' ' : ''}${parts.join(' ')}`.trim();
}

/**
 * The stored number as something a provider will accept.
 *
 * `normalisePhone` produces a **search key** — digits only, so that two
 * spellings of one number match — and a search key is not an address. Every
 * SMS provider wants E.164, and a pumping check that refuses anything without a
 * country code refuses a bare `40722123456` too, which is how a perfectly good
 * number ends up recorded as "not international".
 *
 * Returns `null` rather than a guess when there is nothing dialable, so a
 * caller has to decide what to do about it instead of sending to a plus sign.
 */
export function dialable(normalised: string): string | null {
  const digits = normalised.replace(/\D/g, '');

  // Shorter than the smallest country code plus a subscriber number. Nothing
  // useful can be made of it.
  if (digits.length < 8) return null;

  return `+${digits}`;
}
