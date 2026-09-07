import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * WhatsApp as a channel the log and the suppression list will accept.
 *
 * **The type and the constraint move together.** Adding a member to a
 * TypeScript union lets the code compile and leaves the database refusing the
 * row — a failure that appears in production as "the message vanished", with
 * every test green. That mistake cost a release in `@birtalanrobert/commerce`
 * and it is not repeated here.
 *
 * The suppression list matters as much as the log: a person who has blocked a
 * business on WhatsApp has said so on *that* channel, and continuing to write
 * to them there is how a sending identity gets suspended.
 */
export class AllowWhatsApp1791400000000 implements MigrationInterface {
  name = 'AllowWhatsApp1791400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "mortar_message_log"
        DROP CONSTRAINT IF EXISTS "ck_mortar_message_log_channel"
    `);

    await queryRunner.query(`
      ALTER TABLE "mortar_message_log"
        ADD CONSTRAINT "ck_mortar_message_log_channel"
          CHECK ("channel" IN ('email', 'sms', 'whatsapp'))
    `);

    await queryRunner.query(`
      ALTER TABLE "mortar_suppressions" DROP CONSTRAINT IF EXISTS "ck_suppressions_channel"
    `);

    await queryRunner.query(`
      ALTER TABLE "mortar_suppressions"
        ADD CONSTRAINT "ck_suppressions_channel"
          CHECK ("channel" IN ('email', 'sms', 'whatsapp'))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "mortar_message_log"
        DROP CONSTRAINT IF EXISTS "ck_mortar_message_log_channel"
    `);

    await queryRunner.query(`
      ALTER TABLE "mortar_message_log"
        ADD CONSTRAINT "ck_mortar_message_log_channel"
          CHECK ("channel" IN ('email', 'sms'))
    `);

    await queryRunner.query(`
      ALTER TABLE "mortar_suppressions" DROP CONSTRAINT IF EXISTS "ck_suppressions_channel"
    `);

    await queryRunner.query(`
      ALTER TABLE "mortar_suppressions"
        ADD CONSTRAINT "ck_suppressions_channel"
          CHECK ("channel" IN ('email', 'sms'))
    `);
  }
}
