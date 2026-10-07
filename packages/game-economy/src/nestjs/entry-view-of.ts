import type { EntryKind } from '../kinds';
import type { EntryView } from './economy-views';
import { toAmount } from './to-amount';

/** An entry as Postgres returns it from the service's queries. */
export interface EntryRow {
  id: string;
  seq: string;
  holder_id: string;
  currency: string;
  kind: EntryKind;
  amount: string;
  balance_after: string;
  reason: string;
  reference: string | null;
  refund_of: string | null;
  metadata: Record<string, unknown> | null;
  occurred_at: Date;
}

/** The columns an `EntryRow` is read with. */
export const ENTRY_COLUMNS = `"id", "seq", "holder_id", "currency", "kind", "amount", "balance_after",
  "reason", "reference", "refund_of", "metadata", "occurred_at"`;

export function entryViewOf(row: EntryRow): EntryView {
  return {
    id: row.id,
    seq: toAmount(row.seq),
    holderId: row.holder_id,
    currency: row.currency,
    kind: row.kind,
    amount: toAmount(row.amount),
    balanceAfter: toAmount(row.balance_after),
    reason: row.reason,
    reference: row.reference,
    refundOf: row.refund_of,
    metadata: row.metadata,
    occurredAt: row.occurred_at,
  };
}
