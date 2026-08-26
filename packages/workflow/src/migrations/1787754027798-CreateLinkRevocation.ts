import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateLinkRevocation1787754027798 implements MigrationInterface {
  name = 'CreateLinkRevocation1787754027798';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "mortar_link_revocation" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "jti" varchar(64) NOT NULL,
        "subject" varchar(160) NOT NULL,
        "party" varchar(160),
        "revoked_by" varchar(128),
        "reason" varchar(255),
        "expires_at" timestamptz NOT NULL,
        "revoked_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_link_revocation" PRIMARY KEY ("id"),
        CONSTRAINT "uq_link_revocation_jti" UNIQUE ("jti")
      )
    `);

    // Revoking every link for one subject is the common operation — a request
    // is cancelled, or a party is removed — and it must not scan the table.
    await queryRunner.query(`
      CREATE INDEX "idx_link_revocation_subject"
        ON "mortar_link_revocation" ("tenant_id", "subject")
    `);

    // Drives the sweep: a revocation for a token that has since expired is
    // dead weight, because the token would be rejected on expiry anyway.
    await queryRunner.query(`
      CREATE INDEX "idx_link_revocation_expires"
        ON "mortar_link_revocation" ("expires_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "mortar_link_revocation"`);
  }
}
