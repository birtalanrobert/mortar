import type { MigrationInterface, QueryRunner } from 'typeorm';
import { enableRlsSql } from '@birtalanrobert/tenancy';
import { appendOnlySql, dropAppendOnlySql } from '@birtalanrobert/workflow/nestjs';

/**
 * Stored value: gift vouchers, prepaid packages and balances.
 *
 * Money a customer has already handed over and not yet used. It is the
 * business's cash and the customer's entitlement at the same time, which is why
 * this is a ledger and not a number.
 *
 * ## Why the balance is derived
 *
 * `mortar_voucher_entries` is append-only, enforced by a trigger, and the
 * balance is the sum of it. A counter cannot answer *where did the other four
 * go?*, which is the question that always gets asked — and it breaks in the two
 * ordinary cases a ledger survives: a redemption written twice, and a refund.
 *
 * `balance` **is** on the voucher, as a cache written in the same transaction
 * as the entry that changed it, with `CHECK (balance >= 0)`. The check is the
 * guarantee that a voucher cannot be overspent even if the application is
 * wrong; the ledger is the explanation. A test churns entries and asserts the
 * two still agree.
 *
 * ## Why the code is unique per tenant and not globally
 *
 * A voucher is redeemable at the business that sold it. Two businesses issuing
 * the same twelve characters is not a collision, it is two different pieces of
 * paper — and a global unique index would make one business's issuing rate a
 * function of everybody else's.
 */
export class CreateVouchers1791000000000 implements MigrationInterface {
  name = 'CreateVouchers1791000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "mortar_vouchers" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "tenant_id" uuid NOT NULL,
        -- What is printed on the card. Unique within the business, normalised
        -- before it is stored so a lookup and an issue agree about what a code
        -- is.
        "code" varchar(32) NOT NULL,
        -- 'money' is minor units of the currency; 'units' is a count of
        -- something the business sells. Deliberately not one number with a
        -- comment: ten sessions and a thousand lei must never be added.
        "denomination" varchar(8) NOT NULL,
        "currency" varchar(3),
        -- What a package is for. Null for a gift voucher, which is money and
        -- spends against anything.
        "subject" varchar(160),
        "issued_amount" bigint NOT NULL,
        -- The cache. The ledger is the truth; this is what a constraint can see.
        "balance" bigint NOT NULL,
        "expires_at" timestamptz,
        "cancelled_at" timestamptz,
        "cancelled_reason" varchar(240),
        -- Who it is for, and who bought it — often two different people, which
        -- is most of the point of a gift voucher.
        "holder_id" uuid,
        "holder_name" varchar(160),
        "bought_by_name" varchar(160),
        "note" text,
        CONSTRAINT "pk_vouchers" PRIMARY KEY ("id"),
        CONSTRAINT "uq_vouchers_tenant_id" UNIQUE ("tenant_id", "id"),
        CONSTRAINT "uq_vouchers_code" UNIQUE ("tenant_id", "code"),
        CONSTRAINT "ck_vouchers_denomination"
          CHECK ("denomination" IN ('money', 'units')),
        CONSTRAINT "ck_vouchers_currency"
          CHECK (("denomination" = 'units' AND "currency" IS NULL)
                 OR ("denomination" = 'money' AND "currency" IS NOT NULL)),
        CONSTRAINT "ck_vouchers_issued" CHECK ("issued_amount" > 0),
        /* The guarantee: a voucher cannot be spent past nothing. */
        CONSTRAINT "ck_vouchers_balance"
          CHECK ("balance" >= 0 AND "balance" <= "issued_amount")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "ix_vouchers_holder" ON "mortar_vouchers" ("tenant_id", "holder_id")
        WHERE "holder_id" IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE TABLE "mortar_voucher_entries" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "tenant_id" uuid NOT NULL,
        "voucher_id" uuid NOT NULL,
        "kind" varchar(16) NOT NULL,
        -- Always positive. The direction belongs to the kind: a negative amount
        -- on a redemption reads as a refund to one query and as a double
        -- redemption to another, and both are plausible.
        "amount" bigint NOT NULL,
        -- What it was spent against, in the consuming product's own words —
        -- "booking:<id>", "order:<id>". Never a foreign key: a shared table
        -- takes no key to one product's rows, and a key to either is exactly
        -- what stops the table being shared.
        "subject" varchar(160),
        "note" varchar(400),
        "actor_id" uuid,
        CONSTRAINT "pk_voucher_entries" PRIMARY KEY ("id"),
        CONSTRAINT "uq_voucher_entries_tenant_id" UNIQUE ("tenant_id", "id"),
        CONSTRAINT "fk_voucher_entries_voucher" FOREIGN KEY ("tenant_id", "voucher_id")
          REFERENCES "mortar_vouchers" ("tenant_id", "id") ON DELETE CASCADE,
        CONSTRAINT "ck_voucher_entries_kind"
          CHECK ("kind" IN ('issued', 'redeemed', 'released', 'expired', 'adjusted')),
        CONSTRAINT "ck_voucher_entries_amount" CHECK ("amount" > 0)
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "ix_voucher_entries_voucher"
        ON "mortar_voucher_entries" ("tenant_id", "voucher_id", "created_at")
    `);

    /*
     * Append-only, by the trigger `@birtalanrobert/workflow` already defines.
     *
     * This is the record of somebody else's money, and evidence that can be
     * edited afterwards settles nothing — "the balance was different last week"
     * is exactly the argument it exists to settle. A correction is a new entry.
     *
     * That helper guards `UPDATE` and deliberately not `DELETE`, which matters
     * here: the entries cascade from the voucher, and a trigger refusing
     * deletes would make a tenant's erasure fail on a foreign key rather than
     * on anything anybody intended.
     */
    for (const statement of appendOnlySql('mortar_voucher_entries')) {
      await queryRunner.query(statement);
    }

    for (const statement of enableRlsSql('mortar_vouchers')) {
      await queryRunner.query(statement);
    }

    for (const statement of enableRlsSql('mortar_voucher_entries')) {
      await queryRunner.query(statement);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const statement of dropAppendOnlySql('mortar_voucher_entries')) {
      await queryRunner.query(statement);
    }

    await queryRunner.query(`DROP TABLE IF EXISTS "mortar_voucher_entries" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "mortar_vouchers" CASCADE`);
  }
}
