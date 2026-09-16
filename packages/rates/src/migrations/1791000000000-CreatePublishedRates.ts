import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Every rate any publisher has published, by the day it was published for.
 *
 * **Reference data, and therefore deliberately outside row-level security.**
 * The BNR's rate for the 15th of September is the same fact for every customer
 * of whatever product registers this; giving it a tenant column would mean
 * storing it once per account, and giving it a policy would mean a worker that
 * cannot write it without choosing an account to pretend to be.
 *
 * What makes that safe is that it contains nothing about anybody. Four
 * identifiers, a date and a number, all of them already public — the feeds it
 * comes from are open URLs.
 *
 * **Append-mostly, and keyed on the publication day rather than the fetch
 * time.** §5.3 requires a statement for last March to resolve March's rate for
 * ever, which means a row is a fact about a day rather than about a download:
 * fetching the same ten-day window every morning has to be idempotent, and the
 * unique key below is what makes it so.
 */
export class CreatePublishedRates1791000000000 implements MigrationInterface {
  name = 'CreatePublishedRates1791000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "mortar_published_rates" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" timestamptz NOT NULL DEFAULT now(),

        /* 'BNR', 'ECB', 'MNB'. On every row, because the three disagree. */
        "source" varchar(16) NOT NULL,

        /*
         * Direction, stored exactly as the publisher quotes it.
         *
         * The BNR quotes lei per euro and the ECB quotes euros per leu, for the
         * same pair on the same day. Neither is inverted on the way in —
         * inverting is lossy, and a contract naming one bank must settle at
         * that bank's figure. A reader asks for the direction it needs and the
         * publisher it was promised.
         */
        "base" char(3) NOT NULL,
        "quote" char(3) NOT NULL,

        /** The calendar day the rate was published *for*, not fetched on. */
        "as_of" date NOT NULL,

        /*
         * Ten decimal places, matching RATE_SCALE in
         * @birtalanrobert/money/rates. A numeric rather than a scaled integer
         * so that the column is readable in psql by somebody checking a figure
         * against the bank's own website, which is what happens when a tenant
         * disputes a balance.
         */
        "rate" numeric(20, 10) NOT NULL,

        CONSTRAINT "pk_mortar_published_rates" PRIMARY KEY ("id"),
        /*
         * What makes re-fetching a ten-day window idempotent. The feeds overlap
         * on purpose so a worker that was down over a weekend catches up, and
         * without this every catch-up would duplicate nine days.
         */
        CONSTRAINT "uq_mortar_published_rates_day" UNIQUE ("source", "base", "quote", "as_of"),
        CONSTRAINT "ck_mortar_published_rates_positive" CHECK ("rate" > 0)
      )
    `);

    /*
     * The read settlement makes: one pair, one publisher, the latest on or
     * before a day. Descending on as_of so the answer is the first row.
     */
    await queryRunner.query(`
      CREATE INDEX "ix_mortar_published_rates_lookup"
        ON "mortar_published_rates" ("base", "quote", "source", "as_of" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "mortar_published_rates" CASCADE`);
  }
}
