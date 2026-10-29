/** What an address-shaped run of free text is replaced with. */
export const STRUCK_ADDRESS = '[address]';

/**
 * An email address: something, an `@`, a domain with a dot in it. Loose on
 * purpose — a provider's refusal writes the address its own way, in angle
 * brackets, quotes or parentheses, and one missed is one kept.
 */
const EMAIL = /[^\s<>()[\]"',;:@]+@[^\s<>()[\]"',;:@]+\.[^\s<>()[\]"',;:@]+/g;

/** A telephone number as a provider writes one: E.164, a `+` and seven to fifteen digits. */
const TELEPHONE = /\+\d{7,15}(?!\d)/g;

/**
 * Free text with every address-shaped run struck out: email addresses and
 * E.164 telephone numbers, each replaced with `[address]`.
 *
 * For a product that keeps addresses as fingerprints. The log's free text —
 * a provider's word on a failure, an inbound subject line — can repeat the
 * address it is about (`550 5.1.1 <ana@example.com>: Recipient address
 * rejected`), and a fingerprint in one column is worth nothing beside the
 * address in the next. The rest of the words stay: they are what says why.
 */
export function withoutAddresses(text: string): string {
  return text.replace(EMAIL, STRUCK_ADDRESS).replace(TELEPHONE, STRUCK_ADDRESS);
}
