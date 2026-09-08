import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Web push as a channel, and the subscriptions it needs.
 *
 * **The type and the constraint move together.** Adding a member to a
 * TypeScript union lets the code compile and leaves the database refusing the
 * row — a failure that appears in production as "the notification vanished",
 * with every test green. That mistake cost a release once and is not repeated.
 *
 * ## Why the subscriptions live here
 *
 * A push subscription is an *address* — an endpoint plus the two keys that
 * encrypt to it — and this package already owns addresses, their suppression
 * and their delivery log. Three of the seventeen products send to a PWA, and
 * every one of them would otherwise reimplement the same thing: registering,
 * de-duplicating, and above all **deleting on 410 Gone**, which is the part
 * that goes wrong. A browser that has revoked permission answers 410 for ever,
 * and a product that keeps trying is a product whose delivery figures are
 * quietly meaningless.
 *
 * `subject` names the relationship rather than one product's noun, exactly as
 * the message log's does: an employee here, a customer there, a rep in the
 * third. A foreign key to any of them is what would stop this being shared.
 */
export class AllowPush1792600000000 implements MigrationInterface {
  name = 'AllowPush1792600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "mortar_message_log"
        DROP CONSTRAINT IF EXISTS "ck_mortar_message_log_channel"
    `);

    await queryRunner.query(`
      ALTER TABLE "mortar_message_log"
        ADD CONSTRAINT "ck_mortar_message_log_channel"
          CHECK ("channel" IN ('email', 'sms', 'whatsapp', 'push'))
    `);

    await queryRunner.query(`
      ALTER TABLE "mortar_suppressions" DROP CONSTRAINT IF EXISTS "ck_suppressions_channel"
    `);

    await queryRunner.query(`
      ALTER TABLE "mortar_suppressions"
        ADD CONSTRAINT "ck_suppressions_channel"
          CHECK ("channel" IN ('email', 'sms', 'whatsapp', 'push'))
    `);

    /*
     * One row per browser that has agreed to be written to.
     *
     * The endpoint is the address and the two keys are what encrypt to it. All
     * three come from the browser's own `PushSubscription`, and none of them is
     * a secret we chose — which is why they are stored rather than derived, and
     * why a device that reinstalls arrives as a new row rather than an update.
     */
    await queryRunner.query(`
      CREATE TABLE "mortar_push_subscription" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "tenant_id" uuid,
        /*
         * Whose subscription this is, in the product's own terms.
         *
         * Named for the relationship rather than for one product's noun — an
         * employee here, a customer there — because a foreign key to either is
         * exactly what would stop this table being shared.
         */
        "subject" varchar(200) NOT NULL,
        /* A URL, and long: some push services mint endpoints past 500 bytes. */
        "endpoint" varchar(1000) NOT NULL,
        "p256dh" varchar(255) NOT NULL,
        "auth" varchar(255) NOT NULL,
        /* What the browser called itself, so a person can revoke the right one. */
        "label" varchar(200),
        "last_used_at" timestamptz,
        CONSTRAINT "pk_mortar_push_subscription" PRIMARY KEY ("id")
      )
    `);

    /*
     * One row per endpoint, because the browser mints exactly one.
     *
     * A person who reinstalls a PWA gets a new endpoint and the old one starts
     * answering 410; re-registering the same endpoint is the same device saying
     * so again, and a second row would send them everything twice.
     */
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_mortar_push_subscription_endpoint"
        ON "mortar_push_subscription" ("endpoint")
    `);

    await queryRunner.query(`
      CREATE INDEX "ix_mortar_push_subscription_subject"
        ON "mortar_push_subscription" ("subject")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "mortar_push_subscription"`);

    await queryRunner.query(`
      ALTER TABLE "mortar_suppressions" DROP CONSTRAINT IF EXISTS "ck_suppressions_channel"
    `);
    await queryRunner.query(`
      ALTER TABLE "mortar_suppressions"
        ADD CONSTRAINT "ck_suppressions_channel"
          CHECK ("channel" IN ('email', 'sms', 'whatsapp'))
    `);

    await queryRunner.query(`
      ALTER TABLE "mortar_message_log"
        DROP CONSTRAINT IF EXISTS "ck_mortar_message_log_channel"
    `);
    await queryRunner.query(`
      ALTER TABLE "mortar_message_log"
        ADD CONSTRAINT "ck_mortar_message_log_channel"
          CHECK ("channel" IN ('email', 'sms', 'whatsapp'))
    `);
  }
}
