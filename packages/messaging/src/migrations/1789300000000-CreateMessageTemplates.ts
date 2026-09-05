import type { MigrationInterface, QueryRunner } from 'typeorm';
import { enableRlsSql } from '@birtalanrobert/tenancy';

/**
 * What a business says when something happens, in its own words.
 *
 * The machinery is shared and the words are not — a wedding RSVP reminder and
 * an overdue-rent notice differ in tone, audience and legal weight — so this
 * table knows only that a tenant, an event, a channel and a locale together
 * identify one piece of text. Each product supplies its own events and its own
 * defaults.
 *
 * **A missing row is not an empty message.** It means "the product's default
 * text", which is how a business gets sensible Hungarian without having written
 * any. Turning a message off is `enabled = false`, which is a different fact and
 * needs to stay distinguishable — otherwise stopping a message means deleting
 * words somebody may want back.
 */
export class CreateMessageTemplates1789300000000 implements MigrationInterface {
  name = 'CreateMessageTemplates1789300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "mortar_message_templates" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "tenant_id" uuid NOT NULL,
        -- What happened, as the owning product names it: 'booking.reminder24h'.
        -- No check constraint listing them: one product's events are not
        -- another's, and enumerating them is what would stop this being shared.
        "event" varchar(64) NOT NULL,
        "channel" varchar(16) NOT NULL,
        "locale" varchar(8) NOT NULL,
        -- Null for the channels with no subject line.
        "heading" varchar(200),
        "body" text NOT NULL,
        "enabled" boolean NOT NULL DEFAULT true,
        CONSTRAINT "pk_message_templates" PRIMARY KEY ("id"),
        CONSTRAINT "ck_message_templates_channel"
          CHECK ("channel" IN ('email', 'sms', 'push'))
      )
    `);

    /* One piece of text per tenant, event, channel and language. */
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_message_templates_key"
        ON "mortar_message_templates" ("tenant_id", "event", "channel", "locale")
    `);

    await queryRunner.query(`
      CREATE INDEX "ix_message_templates_tenant"
        ON "mortar_message_templates" ("tenant_id", "event")
    `);

    for (const statement of enableRlsSql('mortar_message_templates')) {
      await queryRunner.query(statement);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "mortar_message_templates" CASCADE`);
  }
}
