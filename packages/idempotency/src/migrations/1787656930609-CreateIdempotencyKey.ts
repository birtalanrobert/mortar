import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateIdempotencyKey1787656930609 implements MigrationInterface {
  name = 'CreateIdempotencyKey1787656930609';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "mortar_idempotency_key" (
        "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id"       uuid,
        "scope"           varchar(128) NOT NULL,
        "key"             varchar(255) NOT NULL,
        "fingerprint"     char(64) NOT NULL,
        "status"          varchar(16) NOT NULL,
        "response_status" int,
        "response_body"   text,
        "claimed_at"      timestamptz NOT NULL DEFAULT now(),
        "completed_at"    timestamptz,
        "expires_at"      timestamptz NOT NULL
      )
    `);

    // The uniqueness that makes concurrency safe. A partial unique index over
    // COALESCE is required because Postgres treats NULLs as distinct, so a
    // plain UNIQUE(tenant_id, scope, key) would let two platform-level
    // requests (tenant_id NULL) claim the same key simultaneously.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_idempotency_scope_key"
        ON "mortar_idempotency_key"
        (COALESCE("tenant_id", '00000000-0000-0000-0000-000000000000'::uuid), "scope", "key")
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_idempotency_expires" ON "mortar_idempotency_key" ("expires_at")`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "mortar_idempotency_key"`);
  }
}
