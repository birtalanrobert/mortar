/**
 * Stored value: gift vouchers, prepaid packages and balances.
 *
 * **Framework-free and browser-safe.** A console counts a balance while
 * somebody types and a booking page shows what a voucher is worth, so nothing
 * here may reach for a database, a clock or Nest. Everything that does lives
 * behind `@birtalanrobert/vouchers/nestjs`.
 */

export {
  applicable,
  balanceOf,
  canRedeem,
  expiryFrom,
  signOf,
  type Denomination,
  type EntryKind,
  type LedgerEntry,
  type Redemption,
  type Refusal,
  type Voucher,
} from './ledger';

export {
  CODE_GROUPS,
  CODE_GROUP_LENGTH,
  codeAlphabet,
  looksLikeCode,
  normaliseCode,
} from './codes';
