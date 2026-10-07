import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the ledger.
 *
 * `mortar_economy_entries` is the record: every purchase, grant, spend and
 * refund, each with the balance it left. `mortar_economy_draws` says which
 * credit each debit took from. Both are **append-only, updates and deletes
 * alike**, enforced here rather than by convention — unlike workflow's
 * transition logs, which permit a delete for an erasure that cascades from a
 * subject. Nothing here keys to a subject: `holder_id` is an opaque id, so an
 * erasure has nothing to remove, and a ledger missing an entry no longer
 * reconciles. `TRUNCATE`, a test's reset, fires no row trigger.
 *
 * `mortar_economy_balances` and `mortar_economy_lots` are caches of the two,
 * written in the same transaction, with the checks that make an overdraft
 * impossible even when the application is wrong: a balance is never below
 * zero, and a credit never has more left than it was, nor less than nothing.
 */
export class CreateGameEconomy1791401023940 implements MigrationInterface {
  name = 'CreateGameEconomy1791401023940';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "mortar_economy_entries" (
        "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "seq"             bigserial NOT NULL,
        "holder_id"       varchar(128) NOT NULL,
        "currency"        varchar(32) NOT NULL,
        "kind"            varchar(16) NOT NULL,
        "amount"          bigint NOT NULL,
        "balance_after"   bigint NOT NULL,
        "reason"          varchar(128) NOT NULL,
        "reference"       varchar(256),
        "idempotency_key" varchar(256) NOT NULL,
        "refund_of"       uuid,
        "metadata"        jsonb,
        "occurred_at"     timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uq_economy_entries_seq" UNIQUE ("seq"),
        CONSTRAINT "uq_economy_entries_key" UNIQUE ("holder_id", "idempotency_key"),
        CONSTRAINT "fk_economy_entries_refund_of" FOREIGN KEY ("refund_of")
          REFERENCES "mortar_economy_entries" ("id"),
        CONSTRAINT "ck_economy_entries_kind"
          CHECK ("kind" IN ('purchase', 'grant', 'spend', 'refund')),
        CONSTRAINT "ck_economy_entries_amount" CHECK ("amount" > 0),
        CONSTRAINT "ck_economy_entries_balance" CHECK ("balance_after" >= 0),
        CONSTRAINT "ck_economy_entries_refund"
          CHECK (("kind" = 'refund') = ("refund_of" IS NOT NULL))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_economy_entries_holder" ON "mortar_economy_entries" ("holder_id", "currency", "seq" DESC)`,
    );
    // A purchase is refunded once, whatever the keys of two requests at once.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_economy_entries_refund_of" ON "mortar_economy_entries" ("refund_of") WHERE "refund_of" IS NOT NULL`,
    );

    await queryRunner.query(`
      CREATE TABLE "mortar_economy_balances" (
        "holder_id"  varchar(128) NOT NULL,
        "currency"   varchar(32) NOT NULL,
        "balance"    bigint NOT NULL DEFAULT 0,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_economy_balances" PRIMARY KEY ("holder_id", "currency"),
        CONSTRAINT "ck_economy_balances_balance" CHECK ("balance" >= 0)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "mortar_economy_lots" (
        "entry_id"  uuid NOT NULL,
        "holder_id" varchar(128) NOT NULL,
        "currency"  varchar(32) NOT NULL,
        "kind"      varchar(16) NOT NULL,
        "amount"    bigint NOT NULL,
        "remaining" bigint NOT NULL,
        "seq"       bigint NOT NULL,
        CONSTRAINT "pk_economy_lots" PRIMARY KEY ("entry_id"),
        CONSTRAINT "fk_economy_lots_entry" FOREIGN KEY ("entry_id")
          REFERENCES "mortar_economy_entries" ("id"),
        CONSTRAINT "ck_economy_lots_kind" CHECK ("kind" IN ('purchase', 'grant')),
        CONSTRAINT "ck_economy_lots_remaining" CHECK ("remaining" >= 0 AND "remaining" <= "amount")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_economy_lots_open" ON "mortar_economy_lots" ("holder_id", "currency", "seq") WHERE "remaining" > 0`,
    );

    await queryRunner.query(`
      CREATE TABLE "mortar_economy_draws" (
        "entry_id" uuid NOT NULL,
        "lot_id"   uuid NOT NULL,
        "amount"   bigint NOT NULL,
        CONSTRAINT "pk_economy_draws" PRIMARY KEY ("entry_id", "lot_id"),
        CONSTRAINT "fk_economy_draws_entry" FOREIGN KEY ("entry_id")
          REFERENCES "mortar_economy_entries" ("id"),
        CONSTRAINT "fk_economy_draws_lot" FOREIGN KEY ("lot_id")
          REFERENCES "mortar_economy_lots" ("entry_id"),
        CONSTRAINT "ck_economy_draws_amount" CHECK ("amount" > 0)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_economy_draws_lot" ON "mortar_economy_draws" ("lot_id")`,
    );

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION mortar_economy_immutable()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
          USING ERRCODE = 'restrict_violation';
      END;
      $$ LANGUAGE plpgsql
    `);
    for (const table of ['mortar_economy_entries', 'mortar_economy_draws']) {
      await queryRunner.query(`
        CREATE TRIGGER "${table}_immutable"
          BEFORE UPDATE OR DELETE ON "${table}"
          FOR EACH ROW EXECUTE FUNCTION mortar_economy_immutable()
      `);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['mortar_economy_draws', 'mortar_economy_entries']) {
      await queryRunner.query(`DROP TRIGGER IF EXISTS "${table}_immutable" ON "${table}"`);
    }
    await queryRunner.query(`DROP FUNCTION IF EXISTS mortar_economy_immutable()`);
    await queryRunner.query(`DROP TABLE IF EXISTS "mortar_economy_draws"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "mortar_economy_lots"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "mortar_economy_balances"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "mortar_economy_entries"`);
  }
}
