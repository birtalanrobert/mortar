/**
 * Stored value, as a ledger rather than a counter.
 *
 * A gift voucher, a ten-session package, a topped-up balance: money or units a
 * customer has already paid for and has not yet used. The specifications for
 * projects 02 and 06 both call for it, and both use the same sentence — *a
 * ledger rather than a counter* — for the same reason.
 *
 * ## Why a ledger
 *
 * A balance stored as a number cannot answer the question that always gets
 * asked: *where did the other four go?* Stored value is somebody else's money
 * until it is used, so the difference between "the balance says six" and "six,
 * and here is each of the four" is the difference between an argument you can
 * settle and one you cannot. It also survives the two things that break a
 * counter — a redemption written twice, and a refund — because both are entries
 * rather than edits.
 *
 * The balance is therefore always **derived**, never stored. Where a database
 * needs one for a constraint, it is a cache of this sum written in the same
 * transaction as the entry that changed it.
 */

/**
 * What the value is counted in.
 *
 * `money` is minor units of a currency: a gift voucher for 200 lei. `units` is
 * a count of something the business sells: ten massages, six lessons. They are
 * deliberately not the same type — redeeming "one" against a money voucher and
 * against a package mean entirely different things, and a single number with a
 * comment would eventually be added to itself.
 */
export type Denomination = 'money' | 'units';

/** What happened, in the order it happened. */
export type EntryKind =
  /** Value put in: the sale, or a top-up. */
  | 'issued'
  /** Value taken out against something. */
  | 'redeemed'
  /** A redemption undone — an appointment cancelled, a mistake at the desk. */
  | 'released'
  /** Value written off because the voucher expired. */
  | 'expired'
  /** The business giving value back, or writing some on. */
  | 'adjusted';

export interface LedgerEntry {
  readonly kind: EntryKind;
  /**
   * Always positive, whatever the kind.
   *
   * The direction is the kind's business, not the number's: a negative amount
   * on a `redeemed` row is the sort of thing that reads as a refund to one
   * query and as a double redemption to another. `signOf` is the single place
   * the direction is decided.
   */
  readonly amount: number;
}

/** Which way each kind moves the balance. */
export function signOf(kind: EntryKind): 1 | -1 {
  return kind === 'issued' || kind === 'released' || kind === 'adjusted' ? 1 : -1;
}

/**
 * What is left, from the entries alone.
 *
 * `adjusted` is signed positive here and a business writing value *off* does it
 * with an `expired` entry — which is honest about what happened rather than
 * hiding a write-off inside a general-purpose correction.
 */
export function balanceOf(entries: readonly LedgerEntry[]): number {
  return entries.reduce((sum, entry) => sum + signOf(entry.kind) * Math.abs(entry.amount), 0);
}

export interface Voucher {
  readonly denomination: Denomination;
  /** The balance, however the caller obtained it. */
  readonly balance: number;
  /** Null means it does not expire, which is the safe default. */
  readonly expiresAt: number | null;
  readonly cancelledAt: number | null;
  /**
   * The service a package is for, when it is one.
   *
   * Null for a gift voucher, which is money and spends against anything. A
   * package of ten massages is not ten of anything else, and a redemption that
   * ignored this would let a customer spend a course of physiotherapy on
   * haircuts.
   */
  readonly serviceId?: string | null;
}

export type Refusal =
  'cancelled' | 'expired' | 'not-enough' | 'wrong-service' | 'nothing-requested';

export type Redemption = { readonly ok: true } | { readonly ok: false; readonly why: Refusal };

/**
 * Whether this voucher will cover that, as of `now`.
 *
 * `now` is a parameter rather than a clock read, like everywhere else in this
 * catalogue: an expiry that depends on when the code happens to run is one
 * nobody can write a test for, and "it expired while the customer was at the
 * counter" is a real support conversation.
 */
export function canRedeem(
  voucher: Voucher,
  request: { readonly amount: number; readonly serviceId?: string | null },
  now: number,
): Redemption {
  if (voucher.cancelledAt !== null) return { ok: false, why: 'cancelled' };
  if (voucher.expiresAt !== null && now >= voucher.expiresAt) return { ok: false, why: 'expired' };

  if (!Number.isFinite(request.amount) || request.amount <= 0) {
    return { ok: false, why: 'nothing-requested' };
  }

  if (voucher.denomination === 'units' && !Number.isInteger(request.amount)) {
    return { ok: false, why: 'nothing-requested' };
  }

  /*
   * A package is for what it was sold for.
   *
   * Only checked when the voucher names a service: a gift voucher is money and
   * spends against anything, which is the whole of what makes it a gift.
   */
  if (
    voucher.serviceId != null &&
    request.serviceId != null &&
    voucher.serviceId !== request.serviceId
  ) {
    return { ok: false, why: 'wrong-service' };
  }

  if (voucher.serviceId != null && request.serviceId == null) {
    return { ok: false, why: 'wrong-service' };
  }

  if (request.amount > voucher.balance) return { ok: false, why: 'not-enough' };

  return { ok: true };
}

/**
 * How much of a bill this voucher can meet.
 *
 * A voucher for 200 against a bill of 350 pays 200 and the customer pays the
 * rest — refusing it because it does not cover the whole thing would be absurd,
 * and it is what a "can you redeem this" boolean quietly leads to.
 */
export function applicable(voucher: Voucher, due: number, now: number): number {
  if (voucher.denomination !== 'money') return 0;
  if (!canRedeem(voucher, { amount: 1 }, now).ok) return 0;

  return Math.max(0, Math.min(voucher.balance, Math.round(due)));
}

/**
 * When a voucher issued now runs out.
 *
 * **Null means never, and that is the default.** Expiry rules for stored value
 * differ by jurisdiction and several treat an unused gift voucher as the
 * customer's money for years — so a product that invented a period would be
 * writing off somebody else's money on a guess. A business that knows its own
 * rule sets one.
 */
export function expiryFrom(issuedAt: number, months: number | null): number | null {
  if (months === null || months <= 0) return null;

  const at = new Date(issuedAt);
  const day = at.getUTCDate();

  at.setUTCMonth(at.getUTCMonth() + months);

  /*
   * The 31st of January plus one month.
   *
   * `setUTCMonth` rolls a short month over into the next one — 31 January
   * becomes 3 March — which would give a customer two extra days, or in the
   * other direction take some away. Clamped to the last day of the month it
   * landed in, which is what everybody means.
   */
  if (at.getUTCDate() !== day) at.setUTCDate(0);

  return at.getTime();
}
