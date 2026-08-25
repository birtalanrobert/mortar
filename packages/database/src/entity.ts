import {
  CreateDateColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  type ColumnOptions,
} from 'typeorm';

/**
 * Column conventions shared by mortar's own tables, and available to projects
 * that want the same shape.
 */

/**
 * Timestamps are stored `timestamptz`, always.
 *
 * A `timestamp without time zone` column is a bug waiting for a daylight-saving
 * transition — and several projects in this catalogue schedule work across
 * exactly those transitions. Postgres stores timestamptz as UTC and converts on
 * the way out, which is the behaviour every one of them assumes.
 */
export const TIMESTAMP_COLUMN: ColumnOptions = { type: 'timestamptz' };

/** Money is stored as an integer count of minor units, per `@mortar/money`. */
export const MONEY_AMOUNT_COLUMN: ColumnOptions = { type: 'bigint' };

/** ISO 4217 currency code. */
export const CURRENCY_COLUMN: ColumnOptions = { type: 'char', length: 3 };

/** Structured payloads use `jsonb`, never `json` — only jsonb is indexable. */
export const JSON_COLUMN: ColumnOptions = { type: 'jsonb' };

/**
 * A base class supplying a uuid primary key and created/updated timestamps.
 *
 * Deliberately not inherited by every mortar entity: some have composite keys
 * or no natural need for an update timestamp, and forcing a base class on them
 * would be worse than a little repetition.
 */
export abstract class BaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
