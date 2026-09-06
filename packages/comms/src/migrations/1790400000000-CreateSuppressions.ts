import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Addresses nothing may be written to.
 *
 * **Checked before every send, not after.** A delivery receipt saying a number
 * refused is a fact nobody acts on: the next reminder goes to the same dead
 * number, is charged for again, and the failure rate carriers watch keeps
 * climbing until a sender identity is blocked. That is the whole reason this
 * table exists.
 *
 * ## Tenant-scoped, which is not obvious
 *
 * A customer telling one salon to stop has not told the salon down the road
 * anything, and a shared list would let one business silence another's customer
 * — or, worse, reveal that the two share one. The cost is that a dead number is
 * discovered once per business, and that is the correct trade.
 *
 * ## Two reasons, because only one of them is a decision
 *
 * `refused` is a fact about an address and expires: people change telephones,
 * and a number suppressed for ever is a customer nobody can reach again over
 * one bad fortnight. `unsubscribed` is a fact about a person and never expires.
 *
 * ## Not under row-level security, and the reason matters
 *
 * `mortar_message_log` is not either, and for the same reason: both are read on
 * the *send* path, which runs in a worker with no tenant bound to the
 * transaction. A policy there does not refuse the read — it returns **no rows**
 * — so the suppression would silently never apply, every reminder would go to
 * every dead number, and nothing anywhere would say so.
 *
 * The isolation is the `tenant_id` column and a service that always filters on
 * it. That is weaker than a policy and it is the honest trade: a control that
 * fails silently in the direction of doing nothing is worse than no control,
 * because it is believed.
 */
export class CreateSuppressions1790400000000 implements MigrationInterface {
  name = 'CreateSuppressions1790400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "mortar_suppressions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "tenant_id" uuid NOT NULL,
        "channel" varchar(8) NOT NULL,
        -- As the provider was given it: E.164, or the email address.
        "address" varchar(320) NOT NULL,
        "reason" varchar(16) NOT NULL,
        -- The provider's own words, or what the person actually sent. "21610:
        -- attempt to send to unsubscribed recipient" is actionable; anything we
        -- substituted for it is what somebody is told when they ask why a
        -- customer stopped hearing from them.
        "detail" varchar(400),
        -- One failure is a telephone switched off; a run of them is a number
        -- that has been disconnected.
        "failures" integer NOT NULL DEFAULT 1,
        "expires_at" timestamptz,
        CONSTRAINT "pk_suppressions" PRIMARY KEY ("id"),
        CONSTRAINT "uq_suppressions_address" UNIQUE ("tenant_id", "channel", "address"),
        CONSTRAINT "ck_suppressions_channel" CHECK ("channel" IN ('email', 'sms')),
        CONSTRAINT "ck_suppressions_reason" CHECK ("reason" IN ('refused', 'unsubscribed'))
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "ix_suppressions_tenant" ON "mortar_suppressions" ("tenant_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "mortar_suppressions" CASCADE`);
  }
}
