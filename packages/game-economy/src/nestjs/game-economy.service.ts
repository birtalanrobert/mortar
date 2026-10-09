import { NotFoundError } from '@birtalanrobert/http';
import { resolveManager, runInTransaction } from '@birtalanrobert/database';
import type { DataSource, EntityManager } from 'typeorm';
import { allocate } from '../allocate';
import { balanceOf } from '../balance-of';
import { InsufficientBalanceError, LedgerKeyReusedError, NotRefundableError } from '../errors';
import { isRefundable } from '../is-refundable';
import type { CreditKind, EntryKind } from '../kinds';
import { isSpendOrder } from '../spend-order';
import type { Draw, Lot } from '../types';
import { checkRequest } from './check-request';
import type { EntryView, LotView, Reconciliation, Reversal } from './economy-views';
import { ENTRY_COLUMNS, entryViewOf, type EntryRow } from './entry-view-of';
import type { GameEconomyOptions } from './game-economy-options.types';
import type { MovementRequest, RefundRequest } from './movement-request.types';
import { toAmount } from './to-amount';

/** An entry's id: anything else names no purchase, and is not sent to Postgres to say so. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface LotRow {
  entry_id: string;
  currency: string;
  kind: CreditKind;
  amount: string;
  remaining: string;
  seq: string;
}

/** What an idempotency key must have been written for, to be answered again. */
interface Expected {
  readonly kind: EntryKind;
  readonly currency: string;
  readonly amount: number;
  readonly refundOf: string | null;
}

/**
 * A game's premium currency, as a ledger.
 *
 * **Every movement is an entry, and the balance is their sum.** Each credit
 * is a lot that debits draw on, in the game's order, so whether a purchase is
 * still whole — and so refundable — is a fact rather than an estimate. The
 * balance and the lots are caches written in the same transaction, behind
 * checks that make an overdraft impossible even when the application is
 * wrong; `reconcile` says whether they still agree with the entries.
 *
 * Every write takes the holder's balance row for that currency first, so a
 * holder's writes take turns, and is idempotent by its key: the same key
 * again answers with the entry it wrote. Every write joins the caller's
 * transaction when there is one — a quest's bonus is credited with the claim
 * that earned it, or not at all.
 */
export class GameEconomyService {
  private readonly order: readonly CreditKind[];

  constructor(
    private readonly dataSource: DataSource,
    options: GameEconomyOptions,
  ) {
    if (!isSpendOrder(options.spendOrder)) {
      throw new Error(
        `The spend order names every kind of credit once: received [${options.spendOrder.join(', ')}].`,
      );
    }
    this.order = [...options.spendOrder];
  }

  /** Currency given by the game: a reward, a prize, an operator's goodwill. Never refundable. */
  async grant(holderId: string, request: MovementRequest): Promise<EntryView> {
    return this.credit(holderId, 'grant', request);
  }

  /** Currency bought with money — refundable while none of it is spent. */
  async purchase(holderId: string, request: MovementRequest): Promise<EntryView> {
    return this.credit(holderId, 'purchase', request);
  }

  /**
   * Currency spent, drawn from the holder's credits in the game's order — all
   * of it or none: refused with `insufficient_balance` when there is less.
   */
  async spend(holderId: string, request: MovementRequest): Promise<EntryView> {
    checkRequest(holderId, request);
    return runInTransaction(this.dataSource, async (manager) => {
      const balance = await this.lock(manager, holderId, request.currency);
      const earlier = await this.written(manager, holderId, request.idempotencyKey, {
        kind: 'spend',
        currency: request.currency,
        amount: request.amount,
        refundOf: null,
      });
      if (earlier) return earlier;

      const draws = allocate(
        await this.openLots(manager, holderId, request.currency),
        request.amount,
        this.order,
      );
      if (!draws) throw new InsufficientBalanceError(request.currency, balance, request.amount);
      const entry = await this.insert(
        manager,
        holderId,
        'spend',
        request,
        balance - request.amount,
      );
      await this.draw(manager, entry.id, draws);
      await this.setBalance(manager, holderId, request.currency, entry.balanceAfter);
      return entry;
    });
  }

  /**
   * A purchase refunded, whole: its currency taken back as its money is
   * handed back — refused with `not_refundable` once any of it is spent, or
   * when it was refunded already, and `not_found` for one not the holder's.
   */
  async refund(holderId: string, request: RefundRequest): Promise<EntryView> {
    checkRequest(holderId, request);
    if (!UUID.test(request.purchaseId)) throw new NotFoundError('Purchase', request.purchaseId);
    return runInTransaction(this.dataSource, async (manager) => {
      const found = await this.lotOf(manager, holderId, request.purchaseId);
      if (!found || found.kind !== 'purchase') {
        throw new NotFoundError('Purchase', request.purchaseId);
      }
      const balance = await this.lock(manager, holderId, found.currency);
      const amount = toAmount(found.amount);
      const earlier = await this.written(manager, holderId, request.idempotencyKey, {
        kind: 'refund',
        currency: found.currency,
        amount,
        refundOf: found.entry_id,
      });
      if (earlier) return earlier;

      // Read again under the lock: a spend may have drawn on it meanwhile.
      const lot = (await this.lotOf(manager, holderId, request.purchaseId))!;
      const remaining = toAmount(lot.remaining);
      if (!isRefundable({ kind: lot.kind, amount, remaining })) {
        throw new NotRefundableError(amount, remaining);
      }
      const entry = await this.insert(
        manager,
        holderId,
        'refund',
        { ...request, currency: lot.currency, amount },
        balance - amount,
        lot.entry_id,
      );
      await this.draw(manager, entry.id, [{ lotId: lot.entry_id, amount }]);
      await this.setBalance(manager, holderId, lot.currency, entry.balanceAfter);
      return entry;
    });
  }

  /**
   * A purchase reversed: its money gone back another way — a refund made at
   * the payment provider, a chargeback — and whatever of its currency is left
   * taken back, which may be less than all of it, or nothing. Answers with
   * what was taken and what the holder had spent of it already, which nothing
   * takes back; the game decides what that costs them.
   *
   * A purchase given back before — refunded, or reversed under another key —
   * takes nothing more, and the answer names that entry instead. The same key
   * again answers as it did the first time. `not_found` for a purchase not the
   * holder's.
   */
  async reverse(holderId: string, request: RefundRequest): Promise<Reversal> {
    checkRequest(holderId, request);
    if (!UUID.test(request.purchaseId)) throw new NotFoundError('Purchase', request.purchaseId);
    return runInTransaction(this.dataSource, async (manager) => {
      const found = await this.lotOf(manager, holderId, request.purchaseId);
      if (!found || found.kind !== 'purchase') {
        throw new NotFoundError('Purchase', request.purchaseId);
      }
      const balance = await this.lock(manager, holderId, found.currency);
      const amount = toAmount(found.amount);

      const [keyed] = (await manager.query(
        `SELECT ${ENTRY_COLUMNS} FROM "mortar_economy_entries"
          WHERE "holder_id" = $1 AND "idempotency_key" = $2`,
        [holderId, request.idempotencyKey],
      )) as EntryRow[];
      if (keyed) {
        const entry = entryViewOf(keyed);
        if (entry.kind !== 'reversal' || entry.refundOf !== found.entry_id) {
          throw new LedgerKeyReusedError(request.idempotencyKey);
        }
        return { entry, taken: entry.amount, spent: amount - entry.amount, earlier: null };
      }

      const [given] = (await manager.query(
        `SELECT ${ENTRY_COLUMNS} FROM "mortar_economy_entries" WHERE "refund_of" = $1`,
        [found.entry_id],
      )) as EntryRow[];
      if (given) return { entry: null, taken: 0, spent: 0, earlier: entryViewOf(given) };

      // Read again under the lock: a spend may have drawn on it meanwhile.
      const lot = (await this.lotOf(manager, holderId, request.purchaseId))!;
      const remaining = toAmount(lot.remaining);
      if (remaining === 0) return { entry: null, taken: 0, spent: amount, earlier: null };
      const entry = await this.insert(
        manager,
        holderId,
        'reversal',
        { ...request, currency: lot.currency, amount: remaining },
        balance - remaining,
        lot.entry_id,
      );
      await this.draw(manager, entry.id, [{ lotId: lot.entry_id, amount: remaining }]);
      await this.setBalance(manager, holderId, lot.currency, entry.balanceAfter);
      return { entry, taken: remaining, spent: amount - remaining, earlier: null };
    });
  }

  /** A holder's balance in a currency: nothing for one never credited. */
  async balance(holderId: string, currency: string): Promise<number> {
    const [row] = (await resolveManager(this.dataSource).query(
      `SELECT "balance" FROM "mortar_economy_balances" WHERE "holder_id" = $1 AND "currency" = $2`,
      [holderId, currency],
    )) as Array<{ balance: string }>;
    return row ? toAmount(row.balance) : 0;
  }

  /** A page of a holder's entries in a currency, the newest first. */
  async history(
    holderId: string,
    currency: string,
    page: { readonly limit?: number; readonly offset?: number } = {},
  ): Promise<{ readonly entries: EntryView[]; readonly total: number }> {
    const manager = resolveManager(this.dataSource);
    const rows = (await manager.query(
      `SELECT ${ENTRY_COLUMNS} FROM "mortar_economy_entries"
        WHERE "holder_id" = $1 AND "currency" = $2
        ORDER BY "seq" DESC OFFSET $3 LIMIT $4`,
      [holderId, currency, page.offset ?? 0, page.limit ?? 50],
    )) as EntryRow[];
    const [count] = (await manager.query(
      `SELECT count(*)::int AS "total" FROM "mortar_economy_entries"
        WHERE "holder_id" = $1 AND "currency" = $2`,
      [holderId, currency],
    )) as Array<{ total: number }>;
    return { entries: rows.map(entryViewOf), total: count!.total };
  }

  /** A holder's credits in a currency, the newest first, each with what is left and whether it may be refunded. */
  async lots(holderId: string, currency: string): Promise<LotView[]> {
    const rows = (await resolveManager(this.dataSource).query(
      `SELECT "entry_id", "currency", "kind", "amount", "remaining", "seq" FROM "mortar_economy_lots"
        WHERE "holder_id" = $1 AND "currency" = $2 ORDER BY "seq" DESC`,
      [holderId, currency],
    )) as LotRow[];
    return rows.map((row) => {
      const amount = toAmount(row.amount);
      const remaining = toAmount(row.remaining);
      return {
        id: row.entry_id,
        kind: row.kind,
        amount,
        remaining,
        refundable: isRefundable({ kind: row.kind, amount, remaining }),
        seq: toAmount(row.seq),
      };
    });
  }

  /**
   * Whether a holder's cached balance, their entries and what is left of their
   * credits still agree. Exposed rather than kept for tests: a cached number
   * can drift, and an operator who suspects one should be able to have it
   * checked rather than argued with.
   */
  async reconcile(holderId: string, currency: string): Promise<Reconciliation> {
    const manager = resolveManager(this.dataSource);
    const movements = (await manager.query(
      `SELECT "kind", "amount" FROM "mortar_economy_entries" WHERE "holder_id" = $1 AND "currency" = $2`,
      [holderId, currency],
    )) as Array<{ kind: EntryKind; amount: string }>;
    const [lots] = (await manager.query(
      `SELECT COALESCE(sum("remaining"), 0)::text AS "left" FROM "mortar_economy_lots"
        WHERE "holder_id" = $1 AND "currency" = $2`,
      [holderId, currency],
    )) as Array<{ left: string }>;
    const balance = await this.balance(holderId, currency);
    const ledger = balanceOf(
      movements.map((movement) => ({ kind: movement.kind, amount: toAmount(movement.amount) })),
    );
    const left = toAmount(lots!.left);
    return { balance, ledger, lots: left, agrees: balance === ledger && ledger === left };
  }

  private async credit(
    holderId: string,
    kind: CreditKind,
    request: MovementRequest,
  ): Promise<EntryView> {
    checkRequest(holderId, request);
    return runInTransaction(this.dataSource, async (manager) => {
      const balance = await this.lock(manager, holderId, request.currency);
      const earlier = await this.written(manager, holderId, request.idempotencyKey, {
        kind,
        currency: request.currency,
        amount: request.amount,
        refundOf: null,
      });
      if (earlier) return earlier;

      const entry = await this.insert(manager, holderId, kind, request, balance + request.amount);
      await manager.query(
        `INSERT INTO "mortar_economy_lots"
           ("entry_id", "holder_id", "currency", "kind", "amount", "remaining", "seq")
         VALUES ($1, $2, $3, $4, $5, $5, $6)`,
        [entry.id, holderId, request.currency, kind, request.amount, entry.seq],
      );
      await this.setBalance(manager, holderId, request.currency, entry.balanceAfter);
      return entry;
    });
  }

  /** The holder's balance row for the currency, made if missing and locked until the transaction ends. */
  private async lock(manager: EntityManager, holderId: string, currency: string): Promise<number> {
    await manager.query(
      `INSERT INTO "mortar_economy_balances" ("holder_id", "currency") VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [holderId, currency],
    );
    const [row] = (await manager.query(
      `SELECT "balance" FROM "mortar_economy_balances"
        WHERE "holder_id" = $1 AND "currency" = $2 FOR UPDATE`,
      [holderId, currency],
    )) as Array<{ balance: string }>;
    return toAmount(row!.balance);
  }

  /**
   * The entry an idempotency key was written for, when it was written for
   * this — or a refusal, when it was written for anything else.
   */
  private async written(
    manager: EntityManager,
    holderId: string,
    key: string,
    expected: Expected,
  ): Promise<EntryView | null> {
    const [row] = (await manager.query(
      `SELECT ${ENTRY_COLUMNS} FROM "mortar_economy_entries"
        WHERE "holder_id" = $1 AND "idempotency_key" = $2`,
      [holderId, key],
    )) as EntryRow[];
    if (!row) return null;
    const entry = entryViewOf(row);
    const same =
      entry.kind === expected.kind &&
      entry.currency === expected.currency &&
      entry.amount === expected.amount &&
      entry.refundOf === expected.refundOf;
    if (!same) throw new LedgerKeyReusedError(key);
    return entry;
  }

  private async insert(
    manager: EntityManager,
    holderId: string,
    kind: EntryKind,
    request: MovementRequest,
    balanceAfter: number,
    refundOf: string | null = null,
  ): Promise<EntryView> {
    const [row] = (await manager.query(
      `INSERT INTO "mortar_economy_entries"
         ("holder_id", "currency", "kind", "amount", "balance_after", "reason", "reference",
          "idempotency_key", "refund_of", "metadata", "occurred_at")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, now()))
       RETURNING ${ENTRY_COLUMNS}`,
      [
        holderId,
        request.currency,
        kind,
        request.amount,
        balanceAfter,
        request.reason,
        request.reference ?? null,
        request.idempotencyKey,
        refundOf,
        request.metadata ?? null,
        request.occurredAt ?? null,
      ],
    )) as EntryRow[];
    return entryViewOf(row!);
  }

  private async draw(
    manager: EntityManager,
    entryId: string,
    draws: readonly Draw[],
  ): Promise<void> {
    for (const draw of draws) {
      await manager.query(
        `INSERT INTO "mortar_economy_draws" ("entry_id", "lot_id", "amount") VALUES ($1, $2, $3)`,
        [entryId, draw.lotId, draw.amount],
      );
      await manager.query(
        `UPDATE "mortar_economy_lots" SET "remaining" = "remaining" - $2 WHERE "entry_id" = $1`,
        [draw.lotId, draw.amount],
      );
    }
  }

  private async setBalance(
    manager: EntityManager,
    holderId: string,
    currency: string,
    balance: number,
  ): Promise<void> {
    await manager.query(
      `UPDATE "mortar_economy_balances" SET "balance" = $3, "updated_at" = now()
        WHERE "holder_id" = $1 AND "currency" = $2`,
      [holderId, currency, balance],
    );
  }

  private async openLots(
    manager: EntityManager,
    holderId: string,
    currency: string,
  ): Promise<Lot[]> {
    const rows = (await manager.query(
      `SELECT "entry_id", "currency", "kind", "amount", "remaining", "seq" FROM "mortar_economy_lots"
        WHERE "holder_id" = $1 AND "currency" = $2 AND "remaining" > 0`,
      [holderId, currency],
    )) as LotRow[];
    return rows.map((row) => ({
      id: row.entry_id,
      kind: row.kind,
      amount: toAmount(row.amount),
      remaining: toAmount(row.remaining),
      seq: toAmount(row.seq),
    }));
  }

  private async lotOf(
    manager: EntityManager,
    holderId: string,
    entryId: string,
  ): Promise<LotRow | null> {
    const [row] = (await manager.query(
      `SELECT "entry_id", "currency", "kind", "amount", "remaining", "seq" FROM "mortar_economy_lots"
        WHERE "entry_id" = $1 AND "holder_id" = $2`,
      [entryId, holderId],
    )) as LotRow[];
    return row ?? null;
  }
}
