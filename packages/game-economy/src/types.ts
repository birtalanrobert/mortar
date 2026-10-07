import type { CreditKind, EntryKind } from './kinds';

/**
 * A credit as spends draw on it: what kind it was, how much, how much of it
 * is left, and its place in the ledger's order.
 */
export interface Lot {
  readonly id: string;
  readonly kind: CreditKind;
  readonly amount: number;
  readonly remaining: number;
  /** The ledger's insertion order: the lower, the older. */
  readonly seq: number;
}

/** What one debit takes from one credit. */
export interface Draw {
  readonly lotId: string;
  readonly amount: number;
}

/** An entry as a sum needs it. */
export interface Movement {
  readonly kind: EntryKind;
  readonly amount: number;
}
