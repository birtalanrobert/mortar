import type { CreditKind, EntryKind } from '../kinds';

/** One entry of the ledger, as the service answers it. */
export interface EntryView {
  readonly id: string;
  /** The ledger's order. */
  readonly seq: number;
  readonly holderId: string;
  readonly currency: string;
  readonly kind: EntryKind;
  readonly amount: number;
  readonly balanceAfter: number;
  readonly reason: string;
  readonly reference: string | null;
  /** For a refund or a reversal, the purchase it gives back. */
  readonly refundOf: string | null;
  readonly metadata: Record<string, unknown> | null;
  readonly occurredAt: Date;
}

/** A credit and what is left of it: what a purchase history shows, refundable or not. */
export interface LotView {
  readonly id: string;
  readonly kind: CreditKind;
  readonly amount: number;
  readonly remaining: number;
  readonly refundable: boolean;
  readonly seq: number;
}

/** What one holder's ledger says, three ways, and whether they agree. */
export interface Reconciliation {
  /** The cached balance. */
  readonly balance: number;
  /** Every credit in, every debit out. */
  readonly ledger: number;
  /** What is left of every credit. */
  readonly lots: number;
  readonly agrees: boolean;
}

/**
 * A purchase reversed: the entry that took back what was left of it — none
 * when nothing was — how much that was, and how much of the purchase the
 * holder had spent already, which nothing can take back.
 */
export interface Reversal {
  readonly entry: EntryView | null;
  readonly taken: number;
  readonly spent: number;
  /**
   * The refund or reversal that had given the purchase back before, under
   * another key: nothing more is taken, and nothing is newly spent.
   */
  readonly earlier: EntryView | null;
}
