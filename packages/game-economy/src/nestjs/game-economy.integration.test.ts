import { randomUUID } from 'node:crypto';
import { createTestDataSource, runInTransaction } from '@birtalanrobert/database';
import { NotFoundError, ValidationError } from '@birtalanrobert/http';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InsufficientBalanceError, LedgerKeyReusedError, NotRefundableError } from '../errors';
import { GameEconomyService } from './game-economy.service';
import { gameEconomyEntities, gameEconomyMigrations } from './index';

let dataSource: DataSource;
let economy: GameEconomyService;

const HOLDER = 'account-ada';
const SILVER = 'silver';
const key = () => randomUUID();
const grant = (amount: number, idempotencyKey = key(), holder = HOLDER) =>
  economy.grant(holder, { currency: SILVER, amount, reason: 'quest.chapter', idempotencyKey });
const buy = (amount: number, idempotencyKey = key()) =>
  economy.purchase(HOLDER, {
    currency: SILVER,
    amount,
    reason: 'stripe.checkout',
    reference: 'cs_test_1',
    idempotencyKey,
  });
const spend = (amount: number, idempotencyKey = key()) =>
  economy.spend(HOLDER, { currency: SILVER, amount, reason: 'hurry.build', idempotencyKey });

beforeAll(async () => {
  // Built by the real migration, so its checks and triggers are what is tested.
  dataSource = await createTestDataSource(gameEconomyEntities, {
    migrations: gameEconomyMigrations,
  });
  economy = new GameEconomyService(dataSource, { spendOrder: ['grant', 'purchase'] });
});

afterAll(async () => {
  if (dataSource?.isInitialized) await dataSource.destroy();
});

beforeEach(async () => {
  // A truncate fires no row trigger: the append-only guard is for rows.
  await dataSource.query(
    `TRUNCATE "mortar_economy_draws", "mortar_economy_lots", "mortar_economy_entries", "mortar_economy_balances"`,
  );
});

describe('credits', () => {
  it('are granted and bought, each an entry with the balance it left, the newest first', async () => {
    const given = await grant(10);
    const bought = await buy(260);

    expect(given).toEqual(
      expect.objectContaining({
        holderId: HOLDER,
        currency: SILVER,
        kind: 'grant',
        amount: 10,
        balanceAfter: 10,
        reason: 'quest.chapter',
        reference: null,
        refundOf: null,
      }),
    );
    expect(bought).toEqual(
      expect.objectContaining({
        kind: 'purchase',
        amount: 260,
        balanceAfter: 270,
        reference: 'cs_test_1',
      }),
    );
    expect(bought.seq).toBeGreaterThan(given.seq);
    expect(await economy.balance(HOLDER, SILVER)).toBe(270);
    expect(await economy.balance(HOLDER, 'gold')).toBe(0);
    expect(await economy.balance('account-nobody', SILVER)).toBe(0);

    const { entries, total } = await economy.history(HOLDER, SILVER);
    expect(total).toBe(2);
    expect(entries.map((entry) => entry.id)).toEqual([bought.id, given.id]);
    expect(await economy.lots(HOLDER, SILVER)).toEqual([
      {
        id: bought.id,
        kind: 'purchase',
        amount: 260,
        remaining: 260,
        refundable: true,
        seq: bought.seq,
      },
      { id: given.id, kind: 'grant', amount: 10, remaining: 10, refundable: false, seq: given.seq },
    ]);
  });

  it('are kept apart by currency and by holder', async () => {
    await grant(10);
    await economy.grant(HOLDER, {
      currency: 'gold',
      amount: 3,
      reason: 'test',
      idempotencyKey: key(),
    });
    await grant(7, key(), 'account-bea');
    expect(await economy.balance(HOLDER, SILVER)).toBe(10);
    expect(await economy.balance(HOLDER, 'gold')).toBe(3);
    expect(await economy.balance('account-bea', SILVER)).toBe(7);
  });

  it('refuse what could only be a mistake, naming every problem at once', async () => {
    const refused = await economy
      .grant('', { currency: '', amount: 0, reason: '', idempotencyKey: '' })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ValidationError);
    expect((refused as ValidationError).errors?.map((problem) => problem.field)).toEqual([
      'holderId',
      'currency',
      'amount',
      'reason',
      'idempotencyKey',
    ]);
    await expect(grant(1.5)).rejects.toBeInstanceOf(ValidationError);
    expect(await economy.balance(HOLDER, SILVER)).toBe(0);
  });
});

describe('spending', () => {
  it('draws on the credits in the game’s order, keeping a purchase whole as long as it can', async () => {
    const bought = await buy(100);
    const given = await grant(30);
    const spent = await spend(40);

    expect(spent).toEqual(expect.objectContaining({ kind: 'spend', amount: 40, balanceAfter: 90 }));
    const lots = await economy.lots(HOLDER, SILVER);
    expect(lots.find((one) => one.id === given.id)).toEqual(
      expect.objectContaining({ remaining: 0, refundable: false }),
    );
    expect(lots.find((one) => one.id === bought.id)).toEqual(
      expect.objectContaining({ remaining: 90, refundable: false }),
    );
    const draws = await dataSource.query(
      `SELECT "lot_id" AS "lot", "amount"::int FROM "mortar_economy_draws" WHERE "entry_id" = $1 ORDER BY "amount" DESC`,
      [spent.id],
    );
    expect(draws).toEqual([
      { lot: given.id, amount: 30 },
      { lot: bought.id, amount: 10 },
    ]);
    expect(await economy.reconcile(HOLDER, SILVER)).toEqual({
      balance: 90,
      ledger: 90,
      lots: 90,
      agrees: true,
    });
  });

  it('draws in another game’s order when that is its policy', async () => {
    const purchasesFirst = new GameEconomyService(dataSource, {
      spendOrder: ['purchase', 'grant'],
    });
    const bought = await buy(100);
    const given = await grant(30);
    await purchasesFirst.spend(HOLDER, {
      currency: SILVER,
      amount: 40,
      reason: 'hurry.build',
      idempotencyKey: key(),
    });
    const lots = await economy.lots(HOLDER, SILVER);
    expect(lots.find((one) => one.id === bought.id)?.remaining).toBe(60);
    expect(lots.find((one) => one.id === given.id)?.remaining).toBe(30);
  });

  it('takes all of it or nothing: more than the balance is refused, and nothing is written', async () => {
    await grant(50);
    const refused = await spend(51).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(InsufficientBalanceError);
    expect((refused as InsufficientBalanceError).meta).toEqual({
      currency: SILVER,
      balance: 50,
      asked: 51,
    });
    expect(await economy.balance(HOLDER, SILVER)).toBe(50);
    expect((await economy.history(HOLDER, SILVER)).total).toBe(1);
    await expect(spend(50)).resolves.toEqual(expect.objectContaining({ balanceAfter: 0 }));
  });

  it('lets one of two spends at once take the last of it', async () => {
    await grant(100);
    const answers = await Promise.allSettled([spend(60), spend(60)]);

    expect(answers.map((answer) => answer.status).sort()).toEqual(['fulfilled', 'rejected']);
    const refused = answers.find((answer) => answer.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(InsufficientBalanceError);
    expect(await economy.reconcile(HOLDER, SILVER)).toEqual(
      expect.objectContaining({ balance: 40, agrees: true }),
    );
  });
});

describe('refunding', () => {
  it('gives back a purchase none of whose currency is spent, once', async () => {
    await grant(10);
    const bought = await buy(260);
    const refunded = await economy.refund(HOLDER, {
      purchaseId: bought.id,
      reason: 'stripe.refund',
      idempotencyKey: key(),
    });

    expect(refunded).toEqual(
      expect.objectContaining({
        kind: 'refund',
        amount: 260,
        balanceAfter: 10,
        refundOf: bought.id,
      }),
    );
    expect((await economy.lots(HOLDER, SILVER)).find((one) => one.id === bought.id)).toEqual(
      expect.objectContaining({ remaining: 0, refundable: false }),
    );
    await expect(
      economy.refund(HOLDER, {
        purchaseId: bought.id,
        reason: 'stripe.refund',
        idempotencyKey: key(),
      }),
    ).rejects.toBeInstanceOf(NotRefundableError);
    expect(await economy.reconcile(HOLDER, SILVER)).toEqual(
      expect.objectContaining({ balance: 10, agrees: true }),
    );
  });

  it('refuses a purchase partly spent, a grant, another holder’s purchase and a name that is no id', async () => {
    const bought = await buy(100);
    const given = await grant(10);
    await spend(15);
    const refund = (purchaseId: string, holder = HOLDER) =>
      economy.refund(holder, { purchaseId, reason: 'stripe.refund', idempotencyKey: key() });

    const partly = await refund(bought.id).catch((error: unknown) => error);
    expect(partly).toBeInstanceOf(NotRefundableError);
    expect((partly as NotRefundableError).meta).toEqual({ amount: 100, remaining: 95 });
    await expect(refund(given.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(refund(bought.id, 'account-bea')).rejects.toBeInstanceOf(NotFoundError);
    await expect(refund('purchase-1')).rejects.toBeInstanceOf(NotFoundError);
    await expect(refund(randomUUID())).rejects.toBeInstanceOf(NotFoundError);
  });

  it('gives back one of two refunds of one purchase at once', async () => {
    const bought = await buy(100);
    const answers = await Promise.allSettled(
      [key(), key()].map((idempotencyKey) =>
        economy.refund(HOLDER, { purchaseId: bought.id, reason: 'stripe.refund', idempotencyKey }),
      ),
    );
    expect(answers.map((answer) => answer.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await economy.balance(HOLDER, SILVER)).toBe(0);
  });
});

describe('reversing', () => {
  const reverse = (purchaseId: string, idempotencyKey = key(), holder = HOLDER) =>
    economy.reverse(holder, { purchaseId, reason: 'stripe.dispute', idempotencyKey });

  it('takes back a purchase none of whose currency is spent, all of it, so it cannot be refunded too', async () => {
    await grant(10);
    const bought = await buy(260);
    const reversed = await reverse(bought.id);

    expect(reversed).toEqual({
      entry: expect.objectContaining({
        kind: 'reversal',
        amount: 260,
        balanceAfter: 10,
        refundOf: bought.id,
        reason: 'stripe.dispute',
      }),
      taken: 260,
      spent: 0,
      earlier: null,
    });
    await expect(
      economy.refund(HOLDER, {
        purchaseId: bought.id,
        reason: 'stripe.refund',
        idempotencyKey: key(),
      }),
    ).rejects.toBeInstanceOf(NotRefundableError);
    expect(await economy.reconcile(HOLDER, SILVER)).toEqual(
      expect.objectContaining({ balance: 10, agrees: true }),
    );
  });

  it('takes back what is left of one partly spent, and says how much of it was spent', async () => {
    await grant(10);
    const bought = await buy(100);
    // The grant first, then five of the purchase.
    await spend(15);
    const reversed = await reverse(bought.id);

    expect(reversed).toEqual(expect.objectContaining({ taken: 95, spent: 5, earlier: null }));
    expect(reversed.entry).toEqual(expect.objectContaining({ amount: 95, balanceAfter: 0 }));
    expect(await economy.reconcile(HOLDER, SILVER)).toEqual(
      expect.objectContaining({ balance: 0, ledger: 0, lots: 0, agrees: true }),
    );
  });

  it('takes nothing from one wholly spent, writes nothing, and says it was spent — the same again', async () => {
    const bought = await buy(100);
    await spend(100);
    const idempotencyKey = key();
    const answer = { entry: null, taken: 0, spent: 100, earlier: null };

    expect(await reverse(bought.id, idempotencyKey)).toEqual(answer);
    expect(await reverse(bought.id, idempotencyKey)).toEqual(answer);
    expect((await economy.history(HOLDER, SILVER)).entries.map((entry) => entry.kind)).toEqual([
      'spend',
      'purchase',
    ]);
  });

  it('takes nothing more from one refunded or reversed already, naming what gave it back', async () => {
    const refundedOne = await buy(100);
    const refund = await economy.refund(HOLDER, {
      purchaseId: refundedOne.id,
      reason: 'stripe.refund',
      idempotencyKey: key(),
    });
    expect(await reverse(refundedOne.id)).toEqual({
      entry: null,
      taken: 0,
      spent: 0,
      earlier: refund,
    });

    const reversedOne = await buy(50);
    const first = await reverse(reversedOne.id);
    expect(await reverse(reversedOne.id)).toEqual({
      entry: null,
      taken: 0,
      spent: 0,
      earlier: first.entry,
    });
    expect(await economy.balance(HOLDER, SILVER)).toBe(0);
  });

  it('answers the same key as it did, and refuses a key written for anything else', async () => {
    const bought = await buy(100);
    const idempotencyKey = key();
    const first = await reverse(bought.id, idempotencyKey);
    expect(await reverse(bought.id, idempotencyKey)).toEqual(first);

    const other = await buy(40);
    await expect(reverse(other.id, idempotencyKey)).rejects.toBeInstanceOf(LedgerKeyReusedError);
    const grantKey = key();
    await grant(5, grantKey);
    await expect(reverse(other.id, grantKey)).rejects.toBeInstanceOf(LedgerKeyReusedError);
  });

  it('refuses a grant, another holder’s purchase and a name that is no id', async () => {
    const bought = await buy(100);
    const given = await grant(10);
    await expect(reverse(given.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(reverse(bought.id, key(), 'account-bea')).rejects.toBeInstanceOf(NotFoundError);
    await expect(reverse('purchase-1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('gives a purchase back once when a refund and a reversal of it come at once', async () => {
    const bought = await buy(100);
    const answers = await Promise.allSettled([
      economy.refund(HOLDER, {
        purchaseId: bought.id,
        reason: 'stripe.refund',
        idempotencyKey: key(),
      }),
      reverse(bought.id),
    ]);
    const givenBack = (await economy.history(HOLDER, SILVER)).entries.filter(
      (entry) => entry.refundOf === bought.id,
    );
    expect(givenBack).toHaveLength(1);
    expect(answers.filter((answer) => answer.status === 'fulfilled').length).toBeGreaterThanOrEqual(
      1,
    );
    expect(await economy.reconcile(HOLDER, SILVER)).toEqual(
      expect.objectContaining({ balance: 0, agrees: true }),
    );
  });
});

describe('idempotency', () => {
  it('answers the same key with the entry it wrote, once credited', async () => {
    const shared = key();
    const first = await grant(10, shared);
    const second = await grant(10, shared);
    expect(second).toEqual(first);
    expect(await economy.balance(HOLDER, SILVER)).toBe(10);

    // A webhook delivered twice at once is credited once.
    const webhook = key();
    const both = await Promise.all([buy(260, webhook), buy(260, webhook)]);
    expect(both[0].id).toBe(both[1].id);
    expect(await economy.balance(HOLDER, SILVER)).toBe(270);
  });

  it('refuses a key written for a different entry, and lets another holder use the same', async () => {
    const shared = key();
    await grant(10, shared);
    await expect(grant(11, shared)).rejects.toBeInstanceOf(LedgerKeyReusedError);
    await expect(spend(10, shared)).rejects.toBeInstanceOf(LedgerKeyReusedError);
    await expect(grant(10, shared, 'account-bea')).resolves.toEqual(
      expect.objectContaining({ holderId: 'account-bea', balanceAfter: 10 }),
    );
    expect(await economy.balance(HOLDER, SILVER)).toBe(10);
  });

  it('answers a spend asked again after the balance ran out with the spend it made', async () => {
    await grant(10);
    const spentKey = key();
    const spent = await spend(10, spentKey);
    await expect(spend(10, spentKey)).resolves.toEqual(spent);
  });
});

describe('the caller’s transaction', () => {
  it('is joined: a credit rolls back with the work that earned it', async () => {
    await expect(
      runInTransaction(dataSource, async () => {
        await grant(10);
        throw new Error('the claim failed');
      }),
    ).rejects.toThrow('the claim failed');
    expect(await economy.balance(HOLDER, SILVER)).toBe(0);
    expect((await economy.history(HOLDER, SILVER)).total).toBe(0);
  });

  it('commits with it', async () => {
    await runInTransaction(dataSource, async () => {
      await grant(10);
      await spend(4);
    });
    expect(await economy.reconcile(HOLDER, SILVER)).toEqual(
      expect.objectContaining({ balance: 6, agrees: true }),
    );
  });
});

describe('the database', () => {
  it('refuses to rewrite or remove an entry or a draw', async () => {
    await grant(10);
    const spent = await spend(4);
    for (const statement of [
      `UPDATE "mortar_economy_entries" SET "amount" = 1`,
      `DELETE FROM "mortar_economy_entries"`,
      `UPDATE "mortar_economy_draws" SET "amount" = 1`,
      `DELETE FROM "mortar_economy_draws" WHERE "entry_id" = '${spent.id}'`,
    ]) {
      await expect(dataSource.query(statement)).rejects.toThrow(/append-only/);
    }
  });

  it('refuses a reversal that names no purchase, whatever the application does', async () => {
    await expect(
      dataSource.query(
        `INSERT INTO "mortar_economy_entries"
           ("holder_id", "currency", "kind", "amount", "balance_after", "reason", "idempotency_key")
         VALUES ('account-ada', 'silver', 'reversal', 1, 0, 'stripe.dispute', 'k')`,
      ),
    ).rejects.toThrow(/ck_economy_entries_refund/);
  });

  it('refuses a balance below zero and a credit with more left than it was, whatever the application does', async () => {
    const given = await grant(10);
    await expect(
      dataSource.query(`UPDATE "mortar_economy_balances" SET "balance" = -1`),
    ).rejects.toThrow(/ck_economy_balances_balance/);
    await expect(
      dataSource.query(`UPDATE "mortar_economy_lots" SET "remaining" = 11 WHERE "entry_id" = $1`, [
        given.id,
      ]),
    ).rejects.toThrow(/ck_economy_lots_remaining/);
  });
});

describe('the spend order', () => {
  it('names every kind of credit once, or the service is not built', () => {
    expect(() => new GameEconomyService(dataSource, { spendOrder: ['grant'] })).toThrow(
      /spend order/,
    );
  });
});
