import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type { EntryKind } from '../kinds';

/**
 * One movement of a holder's currency: a purchase, a grant, a spend or a
 * refund, with the balance it left. Append-only in the database.
 */
@Entity({ name: 'mortar_economy_entries' })
export class EconomyEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The ledger's order: a total one, where two entries in one millisecond would tie. */
  @Column({ type: 'bigint', generated: 'increment' })
  seq!: string;

  /** Whose: an account's id in the consuming game's terms. */
  @Column({ type: 'varchar', length: 128 })
  holderId!: string;

  @Column({ type: 'varchar', length: 32 })
  currency!: string;

  @Column({ type: 'varchar', length: 16 })
  kind!: EntryKind;

  /** Always positive: the kind says which way it went. */
  @Column({ type: 'bigint' })
  amount!: string;

  @Column({ type: 'bigint' })
  balanceAfter!: string;

  /** Why, in the game's words: `quest.chapter`, `steward.month`, `stripe.checkout`. */
  @Column({ type: 'varchar', length: 128 })
  reason!: string;

  /** What it is about, in the game's words: a payment's id, `world:<id>:chapter:3`. */
  @Column({ type: 'varchar', length: 256, nullable: true })
  reference!: string | null;

  @Column({ type: 'varchar', length: 256 })
  idempotencyKey!: string;

  /** For a refund, the purchase it gives back. */
  @Column({ type: 'uuid', nullable: true })
  refundOf!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  @Column({ type: 'timestamptz' })
  occurredAt!: Date;
}
