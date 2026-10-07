import { MortarError } from '@birtalanrobert/http';

/** 409 — a debit asked for more than the holder has. Nothing was taken. */
export class InsufficientBalanceError extends MortarError {
  constructor(currency: string, balance: number, asked: number) {
    super(409, 'insufficient_balance', 'Not enough', {
      detail: `Asked for ${asked} ${currency}; the balance is ${balance}.`,
      meta: { currency, balance, asked },
    });
  }
}

/** 409 — a purchase that may not be refunded: some of it is spent, or it was refunded already. */
export class NotRefundableError extends MortarError {
  constructor(amount: number, remaining: number) {
    super(409, 'not_refundable', 'Not refundable', {
      detail: 'Only a purchase none of whose currency has been spent may be refunded.',
      meta: { amount, remaining },
    });
  }
}

/**
 * 409 — an idempotency key already written for a different entry. The same
 * key with the same entry is answered with the first; with another, it is a
 * caller's mistake that would otherwise lose a credit or a debit silently.
 */
export class LedgerKeyReusedError extends MortarError {
  constructor(key: string) {
    super(409, 'ledger_key_reused', 'Key already used', {
      detail: `The key ${key} was written for a different entry.`,
      meta: { key },
    });
  }
}
