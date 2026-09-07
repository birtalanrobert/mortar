import type { MigrationInterface, QueryRunner } from 'typeorm';
import { enableRlsSql } from '@birtalanrobert/tenancy';

/**
 * Two-way calendar sync.
 *
 * Two tables and no more: **who is connected**, and **what we have written out**
 * to them. Their events are not stored — they are read in a window, turned into
 * busy time, and forgotten. Keeping a copy of somebody's personal calendar
 * would be holding a great deal of data about them for no benefit, which is a
 * data-protection argument before it is a storage one.
 *
 * ## Why the subject is a string
 *
 * A calendar belongs to a stylist in project 02 and to a recruiter in project
 * 08. A foreign key to either is exactly what would stop this table being
 * shared, so the column names the *relationship* — `staff:<id>` — and the
 * consuming product knows what that means.
 *
 * ## Why the refresh token is sealed
 *
 * It is a standing key to somebody's calendar, and it sits in a row for as long
 * as they stay connected. Sealed with AES-256-GCM so that a leaked dump is not
 * a set of working credentials.
 */
export class CreateCalendars1791200000000 implements MigrationInterface {
  name = 'CreateCalendars1791200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "mortar_calendar_connections" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "tenant_id" uuid NOT NULL,
        "subject" varchar(160) NOT NULL,
        "provider" varchar(16) NOT NULL,
        "account" varchar(254),
        "calendar_id" varchar(256) NOT NULL,
        "refresh_token" text NOT NULL,
        "access_token" text,
        "access_expires_at" timestamptz,
        "state" varchar(16) NOT NULL DEFAULT 'active',
        "failures" integer NOT NULL DEFAULT 0,
        "last_error" varchar(400),
        "last_synced_at" timestamptz,
        "sync_due_at" timestamptz,
        -- Two switches, because they are two different consents. Reading
        -- somebody's personal calendar is the more intrusive of the two.
        "pushes" boolean NOT NULL DEFAULT true,
        "pulls" boolean NOT NULL DEFAULT true,
        CONSTRAINT "pk_calendar_connections" PRIMARY KEY ("id"),
        CONSTRAINT "uq_calendar_connections_tenant_id" UNIQUE ("tenant_id", "id"),
        CONSTRAINT "uq_calendar_connections_subject"
          UNIQUE ("tenant_id", "subject", "provider"),
        CONSTRAINT "ck_calendar_connections_provider"
          CHECK ("provider" IN ('google', 'microsoft')),
        CONSTRAINT "ck_calendar_connections_state"
          CHECK ("state" IN ('active', 'revoked', 'disconnected'))
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "ix_calendar_connections_due"
        ON "mortar_calendar_connections" ("tenant_id", "state", "sync_due_at")
    `);

    await queryRunner.query(`
      CREATE TABLE "mortar_calendar_links" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "tenant_id" uuid NOT NULL,
        "connection_id" uuid NOT NULL,
        -- What was copied out, in the product's own words.
        "subject" varchar(160) NOT NULL,
        "external_id" varchar(256) NOT NULL,
        -- What we last wrote, so a change out there is recognisable as one.
        "starts_at" timestamptz NOT NULL,
        "ends_at" timestamptz NOT NULL,
        "title" varchar(400) NOT NULL,
        "drifted_at" timestamptz,
        CONSTRAINT "pk_calendar_links" PRIMARY KEY ("id"),
        CONSTRAINT "uq_calendar_links_tenant_id" UNIQUE ("tenant_id", "id"),
        CONSTRAINT "uq_calendar_links_subject"
          UNIQUE ("tenant_id", "connection_id", "subject"),
        CONSTRAINT "fk_calendar_links_connection" FOREIGN KEY ("tenant_id", "connection_id")
          REFERENCES "mortar_calendar_connections" ("tenant_id", "id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "ix_calendar_links_external"
        ON "mortar_calendar_links" ("tenant_id", "connection_id", "external_id")
    `);

    for (const statement of enableRlsSql('mortar_calendar_connections')) {
      await queryRunner.query(statement);
    }

    for (const statement of enableRlsSql('mortar_calendar_links')) {
      await queryRunner.query(statement);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "mortar_calendar_links" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "mortar_calendar_connections" CASCADE`);
  }
}
