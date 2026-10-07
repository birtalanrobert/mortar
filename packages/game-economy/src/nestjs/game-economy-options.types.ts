import type { CreditKind } from '../kinds';

/** How a game runs its ledger. */
export interface GameEconomyOptions {
  /**
   * Which credits a debit draws on first: every kind once, the oldest first
   * within a kind. The game's own policy — no default is assumed — and the one
   * that decides how long a purchase stays refundable: spending what was
   * granted first keeps what was bought untouched for longer.
   */
  readonly spendOrder: readonly CreditKind[];
}
