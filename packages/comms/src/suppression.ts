import type { SuppressionReason } from './suppression.entity';

/**
 * How many refusals from one address before it is left alone.
 *
 * Three, not one. A single failure is a telephone switched off in a tunnel; a
 * run of them is a number that has been disconnected — and suppressing on the
 * first would silence a customer who happened to be on an aeroplane.
 */
export const REFUSALS_BEFORE_SUPPRESSING = 3;

/**
 * How long a refusal is honoured before the address is worth trying again.
 *
 * Ninety days. People change telephones and mailboxes are reinstated, and an
 * address suppressed for ever is a customer nobody can reach again because of
 * one bad fortnight. An **unsubscribe never expires**: that was a decision
 * rather than a fact about a network.
 */
export const REFUSAL_HOLDS_FOR_DAYS = 90;

/** When a suppression stops applying, or `null` when it never does. */
export function suppressionExpiry(reason: SuppressionReason, now = new Date()): Date | null {
  if (reason === 'unsubscribed') return null;

  const expires = new Date(now);
  expires.setDate(expires.getDate() + REFUSAL_HOLDS_FOR_DAYS);
  return expires;
}

/**
 * The words that mean "stop", in the languages these products are sold in.
 *
 * Matched on the whole message rather than on a substring, because "STOP" is a
 * word that appears in sentences — and a customer writing "stop by at four"
 * has not unsubscribed.
 *
 * The English words are the ones carriers and regulators expect to work
 * whatever the language of the service; the rest are what somebody actually
 * types.
 */
const STOP_WORDS = new Set([
  'stop',
  'stopall',
  'unsubscribe',
  'cancel',
  'end',
  'quit',
  // Romanian
  'oprire',
  'opreste',
  'oprește',
  'stop mesaje',
  'dezabonare',
  // Hungarian
  'leiratkozas',
  'leiratkozás',
  'allj',
  'állj',
  'nem',
]);

/**
 * Whether an inbound message is somebody asking to be left alone.
 *
 * Deliberately generous about punctuation and case and strict about the rest.
 * Missing a "STOP" is a regulatory problem and a complaint; treating a real
 * question as one silently stops answering somebody who wanted an answer, so
 * neither direction is free — but only one of them is a breach of the rules
 * every carrier in both markets enforces.
 */
export function isStopRequest(body: string): boolean {
  const cleaned = body
    .trim()
    .toLowerCase()
    .replace(/[.!?,;:]+$/g, '')
    .replace(/\s+/g, ' ');

  return STOP_WORDS.has(cleaned);
}
