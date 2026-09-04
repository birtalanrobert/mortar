/**
 * The telephone number, as the durable identity of a customer.
 *
 * Extracted from project 12 when project 02 needed the same thing, and it is
 * the same thing in both: a returning customer is one field, and the lookup
 * either finds them or it does not. That makes *matching* what has to be right
 * — the same person typed as `0722 123 456`, `+40722123456` and `0722-123-456`
 * has to be one customer, or a business accumulates three of them and "when was
 * she last in" stops being answerable.
 *
 * No dependencies and nothing framework-shaped, so a browser bundle can import
 * it to decide whether a lookup is worth making before the keystroke lands.
 */

export {
  MARKETS,
  dialable,
  formatPhone,
  isMarket,
  isSearchablePhone,
  normalisePhone,
  type Market,
} from './phone';
