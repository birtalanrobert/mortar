import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * What messages cost, and what a tenant has left.
 *
 * A ledger rather than a counter: "why has my balance gone down by four
 * hundred" is unanswerable against a number and obvious against a list of
 * entries that each name what they were spent on. The balance is a sum over the
 * entries rather than a column, because a column and a list that disagree is a
 * support conversation nobody can win.
 *
 * No foreign key to the subject, deliberately. One product debits against a
 * repair ticket and another against a document request, and a key to either
 * one is precisely what would stop this table being shared.
 */
export class CreateMessageCredits1788390000000 implements MigrationInterface {
  name = 'CreateMessageCredits1788390000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "mortar_message_credits" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "tenant_id" uuid NOT NULL,
        -- Positive for credit bought, negative for messages sent. One column
        -- rather than two, so the balance is a sum rather than a subtraction
        -- somebody can get the wrong way round.
        "segments" int NOT NULL,
        "reason" varchar(24) NOT NULL,
        "subject_id" uuid,
        "note" varchar(255),
        CONSTRAINT "pk_mortar_message_credits" PRIMARY KEY ("id"),
        CONSTRAINT "ck_message_credits_reason"
          CHECK ("reason" IN ('purchase', 'message', 'adjustment', 'refund'))
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "ix_message_credits_tenant"
         ON "mortar_message_credits" ("tenant_id", "created_at" DESC)`,
    );

    await queryRunner.query(`ALTER TABLE "mortar_message_credits" ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE "mortar_message_credits" FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY "tenant_isolation" ON "mortar_message_credits"
        USING ("tenant_id" = current_setting('mortar.tenant_id', true)::uuid)
        WITH CHECK ("tenant_id" = current_setting('mortar.tenant_id', true)::uuid)
    `);

    /*
     * A ledger entry cannot be edited.
     *
     * It is the answer to "what did I pay for", and money that can be rewritten
     * afterwards is not an answer. A correction is a new entry with the
     * opposite sign, which is also how it stays explicable.
     */
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "mortar_message_credits_append_only"() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'mortar_message_credits is append-only; % is not permitted', TG_OP;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_message_credits_append_only"
        BEFORE UPDATE OR DELETE ON "mortar_message_credits"
        FOR EACH ROW EXECUTE FUNCTION "mortar_message_credits_append_only"()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_message_credits_append_only" ON "mortar_message_credits"`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS "mortar_message_credits_append_only"()`);
    await queryRunner.query(`DROP TABLE IF EXISTS "mortar_message_credits"`);
  }
}
