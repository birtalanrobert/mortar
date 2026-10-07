import { CREDIT_KINDS, type EntryKind } from './kinds';
import type { Movement } from './types';

const credits: ReadonlySet<EntryKind> = new Set(CREDIT_KINDS);

/** A ledger's balance: every credit in, every debit out. */
export function balanceOf(movements: readonly Movement[]): number {
  return movements.reduce(
    (sum, movement) => sum + (credits.has(movement.kind) ? movement.amount : -movement.amount),
    0,
  );
}
