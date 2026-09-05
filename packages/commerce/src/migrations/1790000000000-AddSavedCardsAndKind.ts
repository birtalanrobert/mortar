import type { MigrationInterface, QueryRunner } from 'typeorm';
import { enableRlsSql } from '@birtalanrobert/tenancy';

/**
 * A card kept for later, and what each payment was actually for.
 *
 * ## `mortar_saved_cards`
 *
 * The strongest thing a business can do about people not turning up short of
 * taking their money: nothing leaves the customer's account, and the card is
 * there if a fee is later decided on. A **hold is not a substitute** — providers
 * expire an authorisation within days and an appointment is usually further
 * away than that — which is why this is a table and not a longer-lived hold.
 *
 * The consent is stored as **text with a time**, not as a boolean. A flag says
 * somebody clicked; the sentence says what they were told they were agreeing
 * to, and only the second is worth anything when they say they were not told.
 *
 * ## `kind` on a payment
 *
 * A tip belongs to the person who earned it and a product to neither the
 * service nor the diary. Counting all three as service income tells a business
 * its haircuts are more profitable than they are, and nothing computed
 * afterwards can separate them again — so the distinction goes in the row, with
 * `sale` as the default so every existing payment keeps meaning what it meant.
 */
export class AddSavedCardsAndKind1790000000000 implements MigrationInterface {
  name = 'AddSavedCardsAndKind1790000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "mortar_payments"
        ADD COLUMN "kind" varchar(16) NOT NULL DEFAULT 'sale'
    `);

    await queryRunner.query(`
      ALTER TABLE "mortar_payments"
        ADD CONSTRAINT "ck_payments_kind"
          CHECK ("kind" IN ('sale', 'deposit', 'fee', 'tip', 'product'))
    `);

    await queryRunner.query(`
      CREATE TABLE "mortar_saved_cards" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "tenant_id" uuid NOT NULL,
        -- Whose card it is, as the owning product names it. No foreign key, for
        -- the same reason a payment has none: one product hangs a card off a
        -- salon's client, another off a tenant's guest.
        "subject" varchar(160) NOT NULL,
        "provider" varchar(32) NOT NULL DEFAULT 'stripe',
        -- The customer on *our* account. Under a destination charge the money
        -- lands on the business's account while the card stays ours to charge,
        -- and one created on the business's account cannot be used from here.
        "customer_ref" varchar(128) NOT NULL,
        "payment_method_ref" varchar(128) NOT NULL,
        -- Enough to recognise it, and nothing more. We never see the number.
        "brand" varchar(24),
        "last4" varchar(4),
        "expiry_month" int,
        "expiry_year" int,
        -- What they were told they were agreeing to, in the language they read
        -- it in. Required: a card charged on a consent nobody can produce is an
        -- argument the business loses.
        "consent_text" varchar(1000) NOT NULL,
        "consented_at" timestamptz NOT NULL,
        "stored_by" uuid,
        CONSTRAINT "pk_saved_cards" PRIMARY KEY ("id"),
        CONSTRAINT "uq_saved_cards_tenant_id" UNIQUE ("tenant_id", "id"),
        CONSTRAINT "uq_saved_cards_method" UNIQUE ("tenant_id", "payment_method_ref")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "ix_saved_cards_subject"
        ON "mortar_saved_cards" ("tenant_id", "subject")
    `);

    for (const statement of enableRlsSql('mortar_saved_cards')) {
      await queryRunner.query(statement);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "mortar_saved_cards" CASCADE`);
    await queryRunner.query(`
      ALTER TABLE "mortar_payments" DROP CONSTRAINT IF EXISTS "ck_payments_kind"
    `);
    await queryRunner.query(`ALTER TABLE "mortar_payments" DROP COLUMN IF EXISTS "kind"`);
  }
}
