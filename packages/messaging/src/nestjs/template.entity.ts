import { Column, Entity, Index, Unique } from 'typeorm';
import { BaseEntity } from '@birtalanrobert/database';

/** Email has a subject line; SMS and push do not. */
export type TemplateChannel = 'email' | 'sms' | 'push';

/**
 * What a business says when something happens, in one language.
 *
 * The **machinery** is shared; the words are not. A wedding RSVP reminder and
 * an overdue-rent notice differ in tone, audience and legal weight, so every
 * product supplies its own defaults and its own list of events — this table
 * only knows that a tenant, an event, a channel and a locale together identify
 * one piece of text.
 *
 * ## Why a row is per locale rather than a column per language
 *
 * A business that works in two languages and adds a third should not need a
 * migration, and a product that adds a language should not rewrite everybody's
 * templates. A missing row falls back to the product's default, which is how a
 * business gets sensible Hungarian without having written any.
 */
@Entity('mortar_message_templates')
@Unique('uq_message_templates_key', ['tenantId', 'event', 'channel', 'locale'])
@Index('ix_message_templates_tenant', ['tenantId', 'event'])
export class MessageTemplate extends BaseEntity {
  @Column('uuid')
  tenantId!: string;

  /**
   * What happened, as the owning product names it: `booking.reminder24h`.
   *
   * A string rather than an enumeration for the same reason the credit ledger's
   * subject is untyped — one product's events are not another's, and a check
   * constraint listing them is what would stop this table being shared.
   */
  @Column('varchar', { length: 64 })
  event!: string;

  @Column('varchar', { length: 16 })
  channel!: TemplateChannel;

  @Column('varchar', { length: 8 })
  locale!: string;

  /** The subject line. Null for the channels that have none. */
  @Column('varchar', { length: 200, nullable: true })
  heading!: string | null;

  @Column('text')
  body!: string;

  /**
   * Set when a tenant turned this message off entirely.
   *
   * Distinct from having no row: no row means "use the default text", and this
   * means "do not send this at all". Conflating them leaves a business unable
   * to stop a message without deleting words they may want back.
   */
  @Column('boolean', { default: true })
  enabled!: boolean;
}
