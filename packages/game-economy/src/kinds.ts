/**
 * The two ways currency arrives: **bought** with money, or **given** by the
 * game — a quest's reward, a season's prize, an operator's goodwill. Kept
 * apart for good, because only one of them can be refunded and a regulator,
 * an accountant and a chargeback each ask which was which.
 */
export const CREDIT_KINDS = ['purchase', 'grant'] as const;

/**
 * The ways it leaves: **spent** in the game; a purchase **refunded** — its
 * money handed back and all its currency taken back with it; or a purchase
 * **reversed** — its money gone back another way, a refund made at the
 * payment provider or a chargeback, and whatever of its currency is left
 * taken back.
 */
export const DEBIT_KINDS = ['spend', 'refund', 'reversal'] as const;

export type CreditKind = (typeof CREDIT_KINDS)[number];
export type DebitKind = (typeof DEBIT_KINDS)[number];
export type EntryKind = CreditKind | DebitKind;
