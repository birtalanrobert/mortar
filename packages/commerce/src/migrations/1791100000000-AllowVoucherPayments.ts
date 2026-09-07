import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `voucher` as a payment kind.
 *
 * Money taken for stored value — a gift card sold, a package bought. It is a
 * payment because money arrived; a *redemption* is deliberately not one,
 * because none arrives when it is spent, and counting both would tell a
 * business it earned the same two hundred twice.
 *
 * **The constraint had to move as well as the type.** Adding a member to the
 * TypeScript union let the code compile and the database went on refusing the
 * row — which is the shape of every "the types say yes and production says no"
 * failure, and is caught only by a test that actually writes one.
 */
export class AllowVoucherPayments1791100000000 implements MigrationInterface {
  name = 'AllowVoucherPayments1791100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "mortar_payments" DROP CONSTRAINT IF EXISTS "ck_payments_kind"
    `);

    await queryRunner.query(`
      ALTER TABLE "mortar_payments"
        ADD CONSTRAINT "ck_payments_kind"
          CHECK ("kind" IN ('sale', 'deposit', 'fee', 'tip', 'product', 'voucher'))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "mortar_payments" DROP CONSTRAINT IF EXISTS "ck_payments_kind"
    `);

    await queryRunner.query(`
      ALTER TABLE "mortar_payments"
        ADD CONSTRAINT "ck_payments_kind"
          CHECK ("kind" IN ('sale', 'deposit', 'fee', 'tip', 'product'))
    `);
  }
}
