import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateStoredFile1787813455183 implements MigrationInterface {
  name = 'CreateStoredFile1787813455183';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "mortar_stored_file" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "tenant_id" uuid NOT NULL,
        "scope" varchar(128) NOT NULL,
        "object_key" varchar(512) NOT NULL,
        "filename" varchar(255) NOT NULL,
        "content_type" varchar(128),
        "size" bigint,
        "checksum" varchar(64),
        "state" varchar(16) NOT NULL DEFAULT 'pending',
        "reason" text,
        "encrypted" boolean NOT NULL DEFAULT false,
        "key_id" varchar(128),
        "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "uploaded_by" varchar(128),
        "scanned_at" timestamptz,
        "retain_until" timestamptz,
        "deleted_at" timestamptz,
        CONSTRAINT "pk_mortar_stored_file" PRIMARY KEY ("id"),
        CONSTRAINT "uq_mortar_stored_file_key" UNIQUE ("object_key"),
        CONSTRAINT "ck_mortar_stored_file_state"
          CHECK ("state" IN ('pending', 'scanning', 'ready', 'infected', 'rejected'))
      )
    `);

    // "Everything attached to this request" is the query the owning service
    // makes on every screen.
    await queryRunner.query(`
      CREATE INDEX "idx_mortar_stored_file_scope"
        ON "mortar_stored_file" ("tenant_id", "scope")
    `);

    /**
     * Drives the sweep for abandoned uploads.
     *
     * Partial, because it exists to answer one question — which rows never left
     * `pending` — and that set is a rounding error beside every file the system
     * has ever stored.
     */
    await queryRunner.query(`
      CREATE INDEX "idx_mortar_stored_file_pending"
        ON "mortar_stored_file" ("created_at")
       WHERE "state" = 'pending'
    `);

    // Drives retention. Also partial: most rows have no expiry, and the ones
    // that do are the only ones the sweep ever looks at.
    await queryRunner.query(`
      CREATE INDEX "idx_mortar_stored_file_retention"
        ON "mortar_stored_file" ("retain_until")
       WHERE "retain_until" IS NOT NULL AND "deleted_at" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "mortar_stored_file"`);
  }
}
