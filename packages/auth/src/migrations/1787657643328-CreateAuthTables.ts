import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAuthTables1787657643328 implements MigrationInterface {
  name = 'CreateAuthTables1787657643328';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "mortar_user" (
        "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "email"                 varchar(320) NOT NULL,
        "email_verified_at"     timestamptz,
        "password_hash"         text,
        "display_name"          varchar(256),
        "locale"                varchar(16),
        "status"                varchar(16) NOT NULL DEFAULT 'active',
        "failed_login_attempts" int NOT NULL DEFAULT 0,
        "locked_until"          timestamptz,
        "last_login_at"         timestamptz,
        "created_at"            timestamptz NOT NULL DEFAULT now(),
        "updated_at"            timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_user_email" ON "mortar_user" ("email")`);

    await queryRunner.query(`
      CREATE TABLE "mortar_membership" (
        "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_id"    uuid NOT NULL REFERENCES "mortar_user"("id") ON DELETE CASCADE,
        "tenant_id"  uuid NOT NULL,
        "status"     varchar(16) NOT NULL DEFAULT 'active',
        "invited_by" varchar(128),
        "joined_at"  timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_membership_user_tenant" ON "mortar_membership" ("user_id", "tenant_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_membership_tenant" ON "mortar_membership" ("tenant_id", "status")`,
    );

    await queryRunner.query(`
      CREATE TABLE "mortar_role" (
        "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id"   uuid,
        "key"         varchar(64) NOT NULL,
        "name"        varchar(128) NOT NULL,
        "description" text,
        "permissions" text[] NOT NULL DEFAULT '{}',
        "is_system"   boolean NOT NULL DEFAULT false,
        "is_default"  boolean NOT NULL DEFAULT false,
        "created_at"  timestamptz NOT NULL DEFAULT now(),
        "updated_at"  timestamptz NOT NULL DEFAULT now()
      )
    `);
    // Postgres treats NULLs as distinct, so a plain UNIQUE(tenant_id, key)
    // would allow two system roles with the same key.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_role_tenant_key"
        ON "mortar_role"
        (COALESCE("tenant_id", '00000000-0000-0000-0000-000000000000'::uuid), "key")
    `);
    await queryRunner.query(`CREATE INDEX "idx_role_tenant" ON "mortar_role" ("tenant_id")`);

    await queryRunner.query(`
      CREATE TABLE "mortar_membership_role" (
        "membership_id" uuid NOT NULL REFERENCES "mortar_membership"("id") ON DELETE CASCADE,
        "role_id"       uuid NOT NULL REFERENCES "mortar_role"("id") ON DELETE RESTRICT,
        "granted_by"    varchar(128),
        "granted_at"    timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("membership_id", "role_id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_membership_role_role" ON "mortar_membership_role" ("role_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "mortar_session" (
        "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_id"        uuid NOT NULL REFERENCES "mortar_user"("id") ON DELETE CASCADE,
        "token_hash"     varchar(64) NOT NULL,
        "tenant_id"      uuid,
        "expires_at"     timestamptz NOT NULL,
        "last_seen_at"   timestamptz NOT NULL,
        "ip"             inet,
        "user_agent"     varchar(512),
        "revoked_at"     timestamptz,
        "revoked_reason" varchar(64),
        "created_at"     timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_session_token" ON "mortar_session" ("token_hash")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_session_user" ON "mortar_session" ("user_id", "revoked_at")`,
    );
    await queryRunner.query(`CREATE INDEX "idx_session_expiry" ON "mortar_session" ("expires_at")`);

    await queryRunner.query(`
      CREATE TABLE "mortar_auth_token" (
        "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "type"        varchar(32) NOT NULL,
        "token_hash"  varchar(64) NOT NULL,
        "user_id"     uuid REFERENCES "mortar_user"("id") ON DELETE CASCADE,
        "email"       varchar(320) NOT NULL,
        "tenant_id"   uuid,
        "payload"     jsonb,
        "expires_at"  timestamptz NOT NULL,
        "consumed_at" timestamptz,
        "created_by"  varchar(128),
        "created_at"  timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_auth_token_hash" ON "mortar_auth_token" ("token_hash")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_auth_token_lookup" ON "mortar_auth_token" ("type", "email")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_auth_token_expiry" ON "mortar_auth_token" ("expires_at")`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "mortar_auth_token"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "mortar_session"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "mortar_membership_role"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "mortar_role"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "mortar_membership"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "mortar_user"`);
  }
}
