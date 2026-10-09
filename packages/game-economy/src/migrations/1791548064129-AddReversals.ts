import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the reversal: a purchase's currency taken back because its money went
 * back another way — a refund made at the payment provider, a chargeback.
 *
 * A debit like a refund, and of the same purchase — so it carries
 * `refund_of`, and the unique index on that column makes a purchase given
 * back once, by a refund or by a reversal, whichever comes first. Unlike a
 * refund it takes whatever of the purchase is left, which may be less than
 * all of it.
 *
 * `down` restores the narrower checks, and so fails while any reversal is
 * recorded: an append-only ledger is not narrowed by forgetting its entries.
 */
export class AddReversals1791548064129 implements MigrationInterface {
  name = 'AddReversals1791548064129';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "mortar_economy_entries"
        DROP CONSTRAINT "ck_economy_entries_kind",
        DROP CONSTRAINT "ck_economy_entries_refund",
        ADD CONSTRAINT "ck_economy_entries_kind"
          CHECK ("kind" IN ('purchase', 'grant', 'spend', 'refund', 'reversal')),
        ADD CONSTRAINT "ck_economy_entries_refund"
          CHECK (("kind" IN ('refund', 'reversal')) = ("refund_of" IS NOT NULL))
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "mortar_economy_entries"
        DROP CONSTRAINT "ck_economy_entries_kind",
        DROP CONSTRAINT "ck_economy_entries_refund",
        ADD CONSTRAINT "ck_economy_entries_kind"
          CHECK ("kind" IN ('purchase', 'grant', 'spend', 'refund')),
        ADD CONSTRAINT "ck_economy_entries_refund"
          CHECK (("kind" = 'refund') = ("refund_of" IS NOT NULL))
    `);
  }
}
