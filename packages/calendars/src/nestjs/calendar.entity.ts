import { Column, Entity, Index, Unique } from 'typeorm';
import { BaseEntity } from '@birtalanrobert/database';
import type { TenantOwned } from '@birtalanrobert/tenancy';
import type { Provider } from '../sync';

export type ConnectionState = 'active' | 'revoked' | 'disconnected';

/**
 * One person's calendar, connected.
 *
 * Per *subject* rather than per user: a product decides what a calendar belongs
 * to — a stylist in project 02, a recruiter in project 08 — and a foreign key
 * to either is exactly what would stop this table being shared. The string is
 * the consuming product's own: `staff:<id>`, `recruiter:<id>`.
 */
@Entity('mortar_calendar_connections')
@Unique('uq_calendar_connections_tenant_id', ['tenantId', 'id'])
@Unique('uq_calendar_connections_subject', ['tenantId', 'subject', 'provider'])
@Index('ix_calendar_connections_due', ['tenantId', 'state', 'syncDueAt'])
export class CalendarConnection extends BaseEntity implements TenantOwned {
  @Column('uuid')
  tenantId!: string;

  /** Whose calendar this is, in the product's own words. */
  @Column('varchar', { length: 160 })
  subject!: string;

  @Column('varchar', { length: 16 })
  provider!: Provider;

  /** The address of the account, so a screen can say whose calendar it is. */
  @Column('varchar', { length: 254, nullable: true })
  account!: string | null;

  @Column('varchar', { length: 256 })
  calendarId!: string;

  /**
   * Sealed, never plain.
   *
   * A refresh token is a standing key to somebody's calendar. Sealed with
   * `sealSecret` so a leaked database dump is not a set of working
   * credentials — see `@birtalanrobert/database`.
   */
  @Column('text')
  refreshToken!: string;

  @Column('text', { nullable: true })
  accessToken!: string | null;

  @Column('timestamptz', { nullable: true })
  accessExpiresAt!: Date | null;

  @Column('varchar', { length: 16, default: 'active' })
  state!: ConnectionState;

  /**
   * How many times in a row the sync has failed.
   *
   * Reset on any success. It is what decides whether somebody is told: one
   * failure is a provider having an afternoon, and three is a diary that has
   * quietly stopped respecting a personal calendar.
   */
  @Column('integer', { default: 0 })
  failures!: number;

  @Column('varchar', { length: 400, nullable: true })
  lastError!: string | null;

  @Column('timestamptz', { nullable: true })
  lastSyncedAt!: Date | null;

  /** When it is next worth trying. Backed off after a failure. */
  @Column('timestamptz', { nullable: true })
  syncDueAt!: Date | null;

  /**
   * Whether to write our appointments out at all.
   *
   * Some people want their diary in their phone; some only want their dentist
   * appointment to block the booking page. Two switches rather than one,
   * because they are two different consents — and reading somebody's personal
   * calendar is the more intrusive of the two.
   */
  @Column('boolean', { default: true })
  pushes!: boolean;

  @Column('boolean', { default: true })
  pulls!: boolean;
}

/**
 * A copy we wrote out, and what we wrote.
 *
 * Kept so drift can be recognised: if the event out there no longer matches
 * this, somebody has edited our copy and the next sync puts it back.
 */
@Entity('mortar_calendar_links')
@Unique('uq_calendar_links_tenant_id', ['tenantId', 'id'])
@Unique('uq_calendar_links_subject', ['tenantId', 'connectionId', 'subject'])
@Index('ix_calendar_links_external', ['tenantId', 'connectionId', 'externalId'])
export class CalendarLink extends BaseEntity implements TenantOwned {
  @Column('uuid')
  tenantId!: string;

  @Column('uuid')
  connectionId!: string;

  /** What was copied out: `booking:<id>`, `interview:<id>`. */
  @Column('varchar', { length: 160 })
  subject!: string;

  @Column('varchar', { length: 256 })
  externalId!: string;

  /* What we last wrote, so a change out there is recognisable as one. */
  @Column('timestamptz')
  startsAt!: Date;

  @Column('timestamptz')
  endsAt!: Date;

  @Column('varchar', { length: 400 })
  title!: string;

  @Column('timestamptz', { nullable: true })
  driftedAt!: Date | null;
}
