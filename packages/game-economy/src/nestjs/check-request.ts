import { ValidationError, type FieldError } from '@birtalanrobert/http';

const text = (
  errors: FieldError[],
  field: string,
  value: unknown,
  max: number,
  required = true,
) => {
  if (value === undefined && !required) return;
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    errors.push({ field, message: `${field} is 1 to ${max} characters.` });
  }
};

/**
 * Refuses a request that could only be a caller's mistake — a holder or a
 * currency of nothing, an amount that is not a whole positive number — before
 * anything is locked or written, naming every problem at once.
 */
export function checkRequest(
  holderId: string,
  request: {
    readonly currency?: string;
    readonly amount?: number;
    readonly reason: string;
    readonly reference?: string;
    readonly idempotencyKey: string;
  },
): void {
  const errors: FieldError[] = [];
  text(errors, 'holderId', holderId, 128);
  if ('currency' in request) text(errors, 'currency', request.currency, 32);
  if ('amount' in request) {
    const amount = request.amount;
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) {
      errors.push({ field: 'amount', message: 'amount is a whole number above zero.' });
    }
  }
  text(errors, 'reason', request.reason, 128);
  text(errors, 'reference', request.reference, 256, false);
  text(errors, 'idempotencyKey', request.idempotencyKey, 256);
  if (errors.length > 0) throw new ValidationError(errors, 'The ledger refused the request.');
}
