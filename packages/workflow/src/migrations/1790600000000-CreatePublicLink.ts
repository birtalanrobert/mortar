import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The short public links, and the one table in this package with no policy.
 *
 * **Deliberately not row-level secured.** A handle arrives from a stranger with
 * a URL and nothing else — no session, no tenant, nothing a policy could bind
 * to — so the lookup that turns it into a tenant cannot itself require one. A
 * policy here would make every public link return "not found", successfully and
 * silently, for ever.
 *
 * What makes that safe is that the row holds no secrets: a handle, the tenant
 * it belongs to, and what it refers to. The caller binds that tenant and reads
 * the subject under its policy exactly as usual.
 */
export class CreatePublicLink1790600000000 implements MigrationInterface {
  name = 'CreatePublicLink1790600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "mortar_public_link" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        /* 22 base64url characters: the 128 random bits that make it unguessable. */
        "handle" varchar(22) NOT NULL,
        "tenant_id" uuid NOT NULL,
        "subject" varchar(160) NOT NULL,
        "party" varchar(160),
        /* Null means "as long as the subject exists", which is a real answer. */
        "expires_at" timestamptz,
        "revoked_at" timestamptz,
        "revoked_by" varchar(128),
        "reason" varchar(255),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_public_link" PRIMARY KEY ("id"),
        /*
         * Unique across every tenant, because that is how it is looked up:
         * there is no tenant to scope it by until the handle has produced one.
         */
        CONSTRAINT "uq_public_link_handle" UNIQUE ("handle")
      )
    `);

    // Finding or revoking every link for one subject is the common operation —
    // an order is cancelled, a customer asks for a new link — and it must not
    // scan the table.
    await queryRunner.query(`
      CREATE INDEX "idx_public_link_subject"
        ON "mortar_public_link" ("tenant_id", "subject")
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_public_link_expires"
        ON "mortar_public_link" ("expires_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "mortar_public_link"`);
  }
}
