import type { MigrationInterface, QueryRunner } from 'typeorm';
import { enableRlsSql } from '@birtalanrobert/tenancy';

/**
 * What a business pays *us*.
 *
 * The other direction from `@birtalanrobert/commerce`, which is a business
 * charging its own customers with the money never touching us. Different
 * account, different liability, different answer when one fails — and no shared
 * table between them, on purpose.
 *
 * ## Why plans are rows
 *
 * A constant in a deployment would be simpler and is wrong: a plan is
 * referenced by every subscription ever sold on it, and a business that bought
 * "Salon, 149 lei, five staff included" in March keeps those terms when the
 * price list changes in April. Editing a constant rewrites history for
 * everybody on it. So a price change is a **new row**, and a subscription
 * stores the plan's `code`.
 *
 * `mortar_plans` is deliberately **not tenant-scoped**: it is our price list,
 * the same for everybody. A per-tenant plan is how a company acquires four
 * hundred bespoke contracts it cannot change.
 *
 * ## Why usage is stored here as well as at the provider
 *
 * The provider's meter produces the invoice. This produces the answer to "why
 * is my bill 340 lei this month", asked eight months later by somebody with
 * every right to know, and whose provider-side records may by then be
 * aggregated away.
 */
export class CreateBilling1790200000000 implements MigrationInterface {
  name = 'CreateBilling1790200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "mortar_plans" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "code" varchar(64) NOT NULL,
        "name" varchar(120) NOT NULL,
        "interval" varchar(8) NOT NULL DEFAULT 'month',
        "currency" varchar(3) NOT NULL,
        "base_price" bigint NOT NULL,
        "included_quantity" integer NOT NULL DEFAULT 0,
        -- Graduated bands past the allowance. Empty is a flat plan.
        "tiers" jsonb NOT NULL DEFAULT '[]'::jsonb,
        -- Ceilings by name. A null *inside* it means unlimited, which is a real
        -- answer rather than a large number nobody will reach.
        "limits" jsonb NOT NULL DEFAULT '{}'::jsonb,
        -- Absence is the gate. There is deliberately no deny list: a feature
        -- nobody remembered to add to a plan is one nobody can use, which is
        -- discovered immediately, rather than one everybody can, which is not.
        "features" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "trial_days" integer NOT NULL DEFAULT 0,
        "external_price_id" varchar(128),
        "sellable" boolean NOT NULL DEFAULT true,
        "sort_order" integer NOT NULL DEFAULT 100,
        CONSTRAINT "pk_plans" PRIMARY KEY ("id"),
        CONSTRAINT "uq_plans_code" UNIQUE ("code"),
        CONSTRAINT "ck_plans_interval" CHECK ("interval" IN ('month', 'year')),
        CONSTRAINT "ck_plans_base_price" CHECK ("base_price" >= 0)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "mortar_subscriptions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "tenant_id" uuid NOT NULL,
        -- By code, not by key: a business keeps the terms it agreed to when the
        -- price list changes.
        "plan_code" varchar(64) NOT NULL,
        "status" varchar(16) NOT NULL DEFAULT 'none',
        "quantity" integer NOT NULL DEFAULT 0,
        "customer_ref" varchar(128),
        "external_id" varchar(128),
        "trial_ends_at" timestamptz,
        "current_period_end" timestamptz,
        -- Dunning is measured in days from here rather than counted in
        -- attempts, because a customer experiences time and not retries.
        "past_due_since" timestamptz,
        "cancel_at" timestamptz,
        "overage" varchar(8) NOT NULL DEFAULT 'block',
        CONSTRAINT "pk_subscriptions" PRIMARY KEY ("id"),
        CONSTRAINT "uq_subscriptions_tenant" UNIQUE ("tenant_id"),
        CONSTRAINT "ck_subscriptions_status"
          CHECK ("status" IN ('none', 'trialing', 'active', 'past_due', 'paused', 'cancelled')),
        CONSTRAINT "ck_subscriptions_overage" CHECK ("overage" IN ('block', 'charge')),
        CONSTRAINT "ck_subscriptions_quantity" CHECK ("quantity" >= 0)
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "ix_subscriptions_external"
        ON "mortar_subscriptions" ("external_id")
    `);

    await queryRunner.query(`
      CREATE TABLE "mortar_usage_records" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "tenant_id" uuid NOT NULL,
        "meter" varchar(64) NOT NULL,
        -- The tenant's own day, decided by the product rather than by UTC.
        "day" date NOT NULL,
        "quantity" integer NOT NULL DEFAULT 0,
        -- Which rows are still owed to the provider. The gap between counting
        -- and reporting is where a nightly job's failure lives.
        "reported_at" timestamptz,
        CONSTRAINT "pk_usage_records" PRIMARY KEY ("id"),
        CONSTRAINT "uq_usage_records_day" UNIQUE ("tenant_id", "meter", "day"),
        CONSTRAINT "ck_usage_records_quantity" CHECK ("quantity" >= 0)
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "ix_usage_records_reported"
        ON "mortar_usage_records" ("reported_at")
    `);

    /*
     * The two tenant-scoped tables are under row-level security; the price list
     * is not, because it is the same for everybody and a business reading it is
     * reading a shop window.
     */
    for (const table of ['mortar_subscriptions', 'mortar_usage_records']) {
      for (const statement of enableRlsSql(table)) await queryRunner.query(statement);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "mortar_usage_records" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "mortar_subscriptions" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "mortar_plans" CASCADE`);
  }
}
