import type { Lot } from './types';

/**
 * Whether a credit may be refunded: a purchase, none of whose currency has
 * been spent. A partly spent purchase is not — its money bought something
 * already, and handing all of it back would be giving the spent part away.
 * Whether it is still within a refund window is the game's to say.
 */
export function isRefundable(lot: Pick<Lot, 'kind' | 'amount' | 'remaining'>): boolean {
  return lot.kind === 'purchase' && lot.remaining === lot.amount;
}
