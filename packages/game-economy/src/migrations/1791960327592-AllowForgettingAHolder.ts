import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lets the ledger's guard delete one holder's rows, inside `forget`.
 *
 * Entries and draws stay append-only — never rewritten, never removed — but a
 * holder whose records have outlived every period that keeps them may be
 * forgotten whole: `forget` names the holder in a setting local to its
 * transaction (`mortar.economy_forgetting`), and the guard lets a delete of
 * that holder's entries, and of draws made by them, through. Anything else —
 * an update, a delete of another holder's rows, a delete outside `forget` —
 * is refused as before. A guard against mistakes, not against a role that may
 * set the setting itself.
 */
export class AllowForgettingAHolder1791960327592 implements MigrationInterface {
  name = 'AllowForgettingAHolder1791960327592';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION mortar_economy_immutable()
      RETURNS trigger AS $$
      DECLARE
        forgetting text := current_setting('mortar.economy_forgetting', true);
      BEGIN
        -- Nested rather than joined by AND: PL/pgSQL does not promise to stop at
        -- the table's name before reading a column the other table lacks.
        IF TG_OP = 'DELETE' AND forgetting IS NOT NULL AND forgetting <> '' THEN
          IF TG_TABLE_NAME = 'mortar_economy_entries' THEN
            IF OLD.holder_id = forgetting THEN
              RETURN OLD;
            END IF;
          ELSIF TG_TABLE_NAME = 'mortar_economy_draws' THEN
            IF EXISTS (
              SELECT 1 FROM mortar_economy_entries
               WHERE id = OLD.entry_id AND holder_id = forgetting
            ) THEN
              RETURN OLD;
            END IF;
          END IF;
        END IF;
        RAISE EXCEPTION '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
          USING ERRCODE = 'restrict_violation';
      END;
      $$ LANGUAGE plpgsql
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION mortar_economy_immutable()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
          USING ERRCODE = 'restrict_violation';
      END;
      $$ LANGUAGE plpgsql
    `);
  }
}
