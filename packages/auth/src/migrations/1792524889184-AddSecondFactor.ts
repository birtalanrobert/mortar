import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * An account's second factor: one row per account, gone with it. The secret
 * is sealed by the product's key before it reaches this table; the recovery
 * codes are hashes.
 */
export class AddSecondFactor1792524889184 implements MigrationInterface {
  name = 'AddSecondFactor1792524889184';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "mortar_second_factor" (
        "user_id"              uuid PRIMARY KEY REFERENCES "mortar_user"("id") ON DELETE CASCADE,
        "secret_sealed"        text NOT NULL,
        "confirmed_at"         timestamptz,
        "last_step"            integer,
        "recovery_code_hashes" text[] NOT NULL DEFAULT '{}',
        "failed_attempts"      int NOT NULL DEFAULT 0,
        "locked_until"         timestamptz,
        "created_at"           timestamptz NOT NULL DEFAULT now(),
        "updated_at"           timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "ck_mortar_second_factor_failed" CHECK ("failed_attempts" >= 0)
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "mortar_second_factor"`);
  }
}
