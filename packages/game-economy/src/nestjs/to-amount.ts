/**
 * A `bigint` column as a number. Postgres hands a bigint back as text, which
 * a sum would concatenate; past 2^53 a number is no longer exact, and a
 * ledger that rounds is not one, so that is refused rather than approximated.
 */
export function toAmount(value: string | number): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount)) {
    throw new RangeError(`A ledger amount beyond a safe integer: ${value}.`);
  }
  return amount;
}
