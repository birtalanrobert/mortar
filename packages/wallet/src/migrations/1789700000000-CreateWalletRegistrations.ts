import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The tables the update web service needs, and the one Apple writes to.
 *
 * **None of them carries a row-level security policy**, which is a deliberate
 * decision and the sort that has to be written beside the table rather than
 * discovered. Every one of them is read *before any tenant is known*: a device
 * calling the update web service sends an opaque identifier Apple generated and
 * a pass serial, and nothing else — no session, no host, no tenant, because it
 * has none. A policy here would make every lookup return nothing while
 * reporting success, which is what `FORCE ROW LEVEL SECURITY` does to an
 * unbound read.
 *
 * `tenant_id` is recorded so a product can report on its own rows, but nothing
 * tenant-scoped may join to these tables.
 */
export class CreateWalletRegistrations1789700000000 implements MigrationInterface {
  name = 'CreateWalletRegistrations1789700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "mortar_wallet_registration" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "device_library_identifier" varchar(128) NOT NULL,
        "push_token" varchar(200) NOT NULL,
        "pass_type_identifier" varchar(128) NOT NULL,
        "serial_number" varchar(128) NOT NULL,
        "tenant_id" uuid,
        CONSTRAINT "pk_mortar_wallet_registration" PRIMARY KEY ("id"),
        CONSTRAINT "uq_wallet_registration"
          UNIQUE ("device_library_identifier", "pass_type_identifier", "serial_number")
      )
    `);

    /* The push: every device holding one pass. */
    await queryRunner.query(`
      CREATE INDEX "ix_wallet_registration_pass"
        ON "mortar_wallet_registration" ("pass_type_identifier", "serial_number")
    `);

    /* The updated-since query: every pass one device holds. */
    await queryRunner.query(`
      CREATE INDEX "ix_wallet_registration_device"
        ON "mortar_wallet_registration" ("device_library_identifier", "pass_type_identifier")
    `);

    await queryRunner.query(`
      CREATE TABLE "mortar_wallet_push_delivery" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "pass_type_identifier" varchar(128) NOT NULL,
        "serial_number" varchar(128) NOT NULL,
        "device_library_identifier" varchar(128),
        "platform" varchar(16) NOT NULL,
        "status" int NOT NULL,
        "reason" varchar(200),
        "provider_id" varchar(200),
        "tenant_id" uuid,
        CONSTRAINT "pk_mortar_wallet_push_delivery" PRIMARY KEY ("id"),
        CONSTRAINT "ck_wallet_push_platform" CHECK ("platform" IN ('apple', 'google'))
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "ix_wallet_push_pass"
        ON "mortar_wallet_push_delivery" ("pass_type_identifier", "serial_number")
    `);

    await queryRunner.query(`
      CREATE INDEX "ix_wallet_push_created"
        ON "mortar_wallet_push_delivery" ("created_at" DESC)
    `);

    await queryRunner.query(`
      CREATE TABLE "mortar_wallet_device_log" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "message" text NOT NULL,
        CONSTRAINT "pk_mortar_wallet_device_log" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "ix_wallet_device_log_created"
        ON "mortar_wallet_device_log" ("created_at" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "mortar_wallet_device_log"`);
    await queryRunner.query(`DROP TABLE "mortar_wallet_push_delivery"`);
    await queryRunner.query(`DROP TABLE "mortar_wallet_registration"`);
  }
}
