import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the audit log.
 *
 * Registered by the consuming project alongside its own migrations:
 *
 *   migrations: [...mortarMigrations, ...myMigrations]
 */
export class CreateAuditLog1700000000001 implements MigrationInterface {
  name = 'CreateAuditLog1700000000001';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "mortar_audit_log" (
        "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id"       uuid,
        "action"          varchar(128) NOT NULL,
        "entity_type"     varchar(64),
        "entity_id"       varchar(128),
        "actor_id"        varchar(128),
        "actor_type"      varchar(16),
        "actor_name"      varchar(256),
        "impersonated_by" varchar(128),
        "changes"         jsonb,
        "metadata"        jsonb,
        "request_id"      varchar(64),
        "correlation_id"  varchar(64),
        "ip"              inet,
        "user_agent"      varchar(512),
        "occurred_at"     timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_audit_tenant_occurred" ON "mortar_audit_log" ("tenant_id", "occurred_at" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_audit_entity" ON "mortar_audit_log" ("tenant_id", "entity_type", "entity_id", "occurred_at" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_audit_actor" ON "mortar_audit_log" ("tenant_id", "actor_id", "occurred_at" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_audit_correlation" ON "mortar_audit_log" ("correlation_id")`,
    );

    // Append-only, enforced by the database rather than by convention.
    //
    // The service exposes no way to update or delete an individual row, but a
    // trail that merely *happens* not to be edited is worth less than one that
    // cannot be. Bulk time-based purging still works because it runs as the
    // owner, not through this trigger.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION mortar_audit_log_immutable()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'mortar_audit_log is append-only; % is not permitted', TG_OP
          USING ERRCODE = 'restrict_violation';
      END;
      $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(`
      CREATE TRIGGER mortar_audit_log_no_update
        BEFORE UPDATE ON "mortar_audit_log"
        FOR EACH ROW EXECUTE FUNCTION mortar_audit_log_immutable()
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS mortar_audit_log_no_update ON "mortar_audit_log"`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS mortar_audit_log_immutable()`);
    await queryRunner.query(`DROP TABLE IF EXISTS "mortar_audit_log"`);
  }
}
