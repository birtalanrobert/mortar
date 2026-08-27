import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateMessageLog1787813849846 implements MigrationInterface {
  name = 'CreateMessageLog1787813849846';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "mortar_message_log" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "tenant_id" uuid,
        "direction" varchar(16) NOT NULL,
        "channel" varchar(16) NOT NULL,
        "subject" varchar(160),
        "provider_message_id" varchar(255),
        "address" varchar(320) NOT NULL,
        "heading" varchar(255),
        "state" varchar(16) NOT NULL DEFAULT 'accepted',
        "detail" text,
        "segments" int,
        "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "settled_at" timestamptz,
        CONSTRAINT "pk_mortar_message_log" PRIMARY KEY ("id"),
        CONSTRAINT "ck_mortar_message_log_direction"
          CHECK ("direction" IN ('inbound', 'outbound')),
        CONSTRAINT "ck_mortar_message_log_channel" CHECK ("channel" IN ('email', 'sms'))
      )
    `);

    /**
     * What makes handling a redelivered webhook safe.
     *
     * A unique index rather than a check in code, because two redeliveries can
     * arrive at the same moment and a read-then-write between them attaches the
     * same bank statement twice.
     *
     * Partial, because a message we never managed to hand over has no provider
     * id — and in Postgres every NULL is distinct, so without the predicate the
     * index would happily hold ten thousand unsent rows it can never constrain.
     */
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_mortar_message_log_provider"
        ON "mortar_message_log" ("direction", "provider_message_id")
       WHERE "provider_message_id" IS NOT NULL
    `);

    // "Everything sent about this request", which is the support question.
    await queryRunner.query(`
      CREATE INDEX "idx_mortar_message_log_subject"
        ON "mortar_message_log" ("tenant_id", "subject")
    `);

    // Drives the sweep for messages a provider never reported back on.
    await queryRunner.query(`
      CREATE INDEX "idx_mortar_message_log_state"
        ON "mortar_message_log" ("state", "created_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "mortar_message_log"`);
  }
}
