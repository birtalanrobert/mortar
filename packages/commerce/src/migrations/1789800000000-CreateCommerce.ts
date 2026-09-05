import type { MigrationInterface, QueryRunner } from 'typeorm';
import { enableRlsSql } from '@birtalanrobert/tenancy';

/**
 * Taking money on a business's behalf.
 *
 * **We never hold anybody's funds.** The customer pays the business directly
 * and our fee is taken on top — a hard architectural rule rather than a
 * preference, because holding third-party money turns a software company into a
 * regulated payments business. Everything here follows from that.
 *
 * ## Three tables, and why each is separate
 *
 * `mortar_payout_accounts` is the gate. Until the provider has verified who a
 * business is, there is nowhere for a payment to land, and every product that
 * sells on somebody's behalf has to answer that same question in front of the
 * same button.
 *
 * `mortar_payments` is the record, and it **outlives the provider**: amounts,
 * dates, what it was for and who decided are stored in full rather than as
 * identifiers to fetch later. A business must be able to produce its own
 * takings years after the provider account is closed or the vendor replaced.
 *
 * `mortar_payment_refunds` is one row per act of giving money back. Several
 * partial refunds against one payment is ordinary, and a single column cannot
 * say when each happened or why.
 *
 * ## No foreign key to whatever was paid for
 *
 * One product takes a deposit against an appointment, another against a seat, a
 * third against a table's tab. A key to any one of them is exactly what would
 * stop this table being shared, so the subject is a string the owning product
 * writes and reads.
 */
export class CreateCommerce1789800000000 implements MigrationInterface {
  name = 'CreateCommerce1789800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "mortar_payout_accounts" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "tenant_id" uuid NOT NULL,
        "provider" varchar(32) NOT NULL DEFAULT 'stripe',
        "external_id" varchar(128) NOT NULL,
        "status" varchar(16) NOT NULL DEFAULT 'pending',
        -- What the provider still wants, in its own words. "A photograph of the
        -- director's identity document" is actionable; "restricted" is a
        -- support conversation.
        "requirements" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "ready_at" timestamptz,
        CONSTRAINT "pk_payout_accounts" PRIMARY KEY ("id"),
        CONSTRAINT "uq_payout_accounts_tenant" UNIQUE ("tenant_id", "provider"),
        CONSTRAINT "ck_payout_accounts_status"
          CHECK ("status" IN ('none', 'pending', 'restricted', 'ready'))
      )
    `);

    /* A webhook arrives naming the provider's account, not ours. */
    await queryRunner.query(`
      CREATE INDEX "ix_payout_accounts_external"
        ON "mortar_payout_accounts" ("provider", "external_id")
    `);

    await queryRunner.query(`
      CREATE TABLE "mortar_payments" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "tenant_id" uuid NOT NULL,
        -- What it was for, as the owning product names it. No foreign key: see
        -- the note above.
        "subject" varchar(160) NOT NULL,
        -- 'card' is the only one this package processes. The rest are recorded
        -- rather than taken, and recording them is not a lesser feature: a
        -- report that counts only what a provider processed tells a salon a
        -- fraction of its own takings and looks complete.
        "method" varchar(16) NOT NULL,
        "state" varchar(24) NOT NULL DEFAULT 'pending',
        "amount" bigint NOT NULL,
        "currency" varchar(3) NOT NULL,
        -- Recorded even when zero: "charged nothing" and "nobody wrote down
        -- what was charged" are different facts.
        "application_fee" bigint NOT NULL DEFAULT 0,
        "refunded" bigint NOT NULL DEFAULT 0,
        "provider" varchar(32),
        "external_id" varchar(128),
        -- "Visa ending 4242". Never the number, never anything chargeable from
        -- a database dump.
        "instrument" varchar(40),
        "taken_at" timestamptz,
        "detail" varchar(400),
        "recorded_by" uuid,
        CONSTRAINT "pk_payments" PRIMARY KEY ("id"),
        CONSTRAINT "uq_payments_tenant_id" UNIQUE ("tenant_id", "id"),
        CONSTRAINT "ck_payments_method"
          CHECK ("method" IN ('card', 'cash', 'terminal', 'voucher', 'transfer')),
        CONSTRAINT "ck_payments_state"
          CHECK ("state" IN ('pending', 'authorized', 'captured', 'failed',
                             'refunded', 'partially_refunded', 'cancelled')),
        -- Money is never negative here, and nothing may be given back twice.
        CONSTRAINT "ck_payments_amount" CHECK ("amount" >= 0),
        CONSTRAINT "ck_payments_refunded"
          CHECK ("refunded" >= 0 AND "refunded" <= "amount")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "ix_payments_subject" ON "mortar_payments" ("tenant_id", "subject")
    `);
    /* Every revenue report reads this: a tenant's takings over a period. */
    await queryRunner.query(`
      CREATE INDEX "ix_payments_taken" ON "mortar_payments" ("tenant_id", "taken_at")
    `);
    /* And a webhook arrives naming the provider's payment. */
    await queryRunner.query(`
      CREATE INDEX "ix_payments_external" ON "mortar_payments" ("provider", "external_id")
    `);

    await queryRunner.query(`
      CREATE TABLE "mortar_payment_refunds" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "tenant_id" uuid NOT NULL,
        "payment_id" uuid NOT NULL,
        "amount" bigint NOT NULL,
        -- Required. "We refunded her ninety lei in March" is a question
        -- somebody asks a year later, and a blank reason cannot be defended.
        "reason" varchar(400) NOT NULL,
        "external_id" varchar(128),
        "refunded_by" uuid,
        CONSTRAINT "pk_payment_refunds" PRIMARY KEY ("id"),
        CONSTRAINT "fk_payment_refunds_payment" FOREIGN KEY ("tenant_id", "payment_id")
          REFERENCES "mortar_payments" ("tenant_id", "id") ON DELETE RESTRICT,
        CONSTRAINT "ck_payment_refunds_amount" CHECK ("amount" > 0)
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "ix_payment_refunds_payment"
        ON "mortar_payment_refunds" ("tenant_id", "payment_id")
    `);

    for (const table of ['mortar_payout_accounts', 'mortar_payments', 'mortar_payment_refunds']) {
      for (const statement of enableRlsSql(table)) await queryRunner.query(statement);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "mortar_payment_refunds" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "mortar_payments" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "mortar_payout_accounts" CASCADE`);
  }
}
