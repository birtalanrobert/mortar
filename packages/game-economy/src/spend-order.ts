import { CREDIT_KINDS, type CreditKind } from './kinds';

/**
 * Whether an order names every kind of credit exactly once.
 *
 * Which credit a spend draws on first is a game's own policy, and it decides
 * who may be refunded: a game that spends granted currency first keeps a
 * purchase refundable for longer. An order that left a kind out would strand
 * that kind's currency — counted in the balance, never spendable — so it is
 * refused when the service is built rather than discovered by a player.
 */
export function isSpendOrder(order: readonly CreditKind[]): boolean {
  return order.length === CREDIT_KINDS.length && CREDIT_KINDS.every((kind) => order.includes(kind));
}
