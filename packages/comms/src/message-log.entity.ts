import { Check, Column, Entity, Index } from 'typeorm';
import { BaseEntity, JSON_COLUMN, TIMESTAMP_COLUMN } from '@birtalanrobert/database';

export type MessageDirection = 'inbound' | 'outbound';

export type MessageState =
  'accepted' | 'delivered' | 'bounced' | 'failed' | 'received' | 'discarded';

/**
 * Every message in or out, and what became of it.
 *
 * Two jobs, and the second is the one that shapes the table.
 *
 * The first is answering "did my client actually get that reminder?", which a
 * professional asks whenever a deadline passes quietly. Without a log the
 * honest answer is "we think so".
 *
 * The second is **not doing the same thing twice**. Providers redeliver inbound
 * webhooks — that is how at-least-once delivery works — and without a record of
 * what has already been handled, a client's forwarded bank statement is
 * attached to their request three times. The unique constraint on the
 * provider's id is what makes the handler idempotent, and it is a database
 * constraint rather than a check in code because two redeliveries can arrive at
 * the same moment.
 */
@Entity({ name: 'mortar_message_log' })
@Index('ix_mortar_message_log_subject', ['tenantId', 'subject'])
@Index('ix_mortar_message_log_state', ['state', 'createdAt'])
@Check('ck_mortar_message_log_direction', `"direction" IN ('inbound', 'outbound')`)
@Check('ck_mortar_message_log_channel', `"channel" IN ('email', 'sms')`)
export class MessageLog extends BaseEntity {
  /** Null for a message that arrived before we knew whose it was. */
  @Column({ type: 'uuid', nullable: true })
  tenantId!: string | null;

  @Column({ type: 'varchar', length: 16 })
  direction!: MessageDirection;

  @Column({ type: 'varchar', length: 16 })
  channel!: 'email' | 'sms';

  /** What this is about, as `type:id`. Null when it could not be routed. */
  @Column({ type: 'varchar', length: 160, nullable: true })
  subject!: string | null;

  /**
   * The provider's own id.
   *
   * Unique per direction, enforced by a **partial** unique index in the
   * migration rather than by a decorator here — a message we never managed to
   * hand over has no id, and TypeORM's `@Unique` cannot express the `WHERE`
   * that keeps those rows out of the index. Declaring it both ways would leave
   * the entity claiming a constraint the database does not have.
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  providerMessageId!: string | null;

  @Column({ type: 'varchar', length: 320 })
  address!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  heading!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'accepted' })
  state!: MessageState;

  /** Why it bounced, failed or was discarded, in the provider's words. */
  @Column({ type: 'text', nullable: true })
  detail!: string | null;

  /** Billable SMS segments, where the provider reports them. */
  @Column({ type: 'int', nullable: true })
  segments!: number | null;

  /**
   * Anything worth keeping that is not a column.
   *
   * Never the message body. A reminder is innocuous; a document collection
   * product's inbound mail is bank statements, and a log table is the last
   * place they should be sitting when someone asks for an erasure.
   */
  @Column({ ...JSON_COLUMN, default: () => `'{}'::jsonb` })
  metadata!: Record<string, unknown>;

  @Column({ ...TIMESTAMP_COLUMN, nullable: true })
  settledAt!: Date | null;
}
