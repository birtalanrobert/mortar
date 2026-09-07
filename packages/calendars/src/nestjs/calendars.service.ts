import { Inject, Injectable } from '@nestjs/common';
import { In, LessThanOrEqual } from 'typeorm';
import type { DataSource } from 'typeorm';
import { InjectDataSource, openSecret, sealSecret } from '@birtalanrobert/database';
import { runInTenantTransaction } from '@birtalanrobert/tenancy';
import { NotFoundError } from '@birtalanrobert/http';
import {
  busyFrom,
  driftOf,
  healthOf,
  shouldPush,
  syncWindow,
  type Health,
  type Provider,
} from '../sync';
import { CalendarRevoked, type CalendarProvider } from '../providers/port';
import { CalendarConnection, CalendarLink } from './calendar.entity';

/** The providers this deployment can talk to, by name. */
export const CALENDAR_PROVIDERS = Symbol('CALENDAR_PROVIDERS');

/** The key sealed tokens are stored under. */
export const CALENDAR_SEALING_KEY = Symbol('CALENDAR_SEALING_KEY');

/** An appointment, as the product describes it to us. */
export interface Appointment {
  /** `booking:<id>`, `interview:<id>` — the product's own words. */
  readonly subject: string;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly title: string;
  readonly description?: string;
  readonly timezone: string;
  readonly cancelled: boolean;
}

export interface ConnectionView {
  readonly id: string;
  readonly subject: string;
  readonly provider: Provider;
  readonly account: string | null;
  readonly calendarId: string;
  readonly health: Health;
  readonly lastSyncedAt: string | null;
  readonly lastError: string | null;
  readonly pushes: boolean;
  readonly pulls: boolean;
}

/** What a pull found, for the product to act on. */
export interface PulledBusy {
  readonly connectionId: string;
  readonly subject: string;
  readonly periods: ReadonlyArray<{ startsAt: number; endsAt: number }>;
}

/**
 * Connecting calendars, and keeping them in step.
 *
 * The rules are in `sync.ts` and this applies them. It deliberately does *not*
 * decide what a busy period means to the product: it returns them, and the
 * product turns them into whatever it uses for time nobody may have — a block,
 * a hold, a greyed-out hour. A shared package that wrote into a product's own
 * diary table would be a shared package with a foreign key into it.
 */
@Injectable()
export class CalendarsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CALENDAR_PROVIDERS)
    private readonly providers: ReadonlyMap<Provider, CalendarProvider>,
    @Inject(CALENDAR_SEALING_KEY) private readonly key: Buffer,
  ) {}

  /** Which providers this deployment is configured for. */
  available(): Provider[] {
    return [...this.providers.keys()];
  }

  /** Where to send somebody to say yes. */
  authorizeUrl(provider: Provider, state: string, redirectUri: string): string {
    return this.providerFor(provider).authorizeUrl({ state, redirectUri });
  }

  /**
   * Finishes a connection, from the code a callback carried.
   *
   * Reconnecting an existing subject **replaces** the row rather than adding
   * one: somebody who disconnects and reconnects has one calendar, and two rows
   * would mean two copies of every appointment in it.
   */
  async connect(
    tenantId: string,
    input: {
      readonly subject: string;
      readonly provider: Provider;
      readonly code: string;
      readonly redirectUri: string;
      readonly calendarId?: string;
    },
  ): Promise<ConnectionView> {
    const provider = this.providerFor(input.provider);
    const tokens = await provider.exchange({
      code: input.code,
      redirectUri: input.redirectUri,
    });

    if (!tokens.refreshToken) {
      /*
       * No refresh token, no connection.
       *
       * Both providers issue one on the first consent and then stop, so a
       * reconnection without `prompt=consent` yields an access token that dies
       * within the hour. Refusing here is far kinder than a calendar that
       * appears to work until lunchtime.
       */
      throw new Error(
        `${input.provider} returned no refresh token. The consent screen must be forced.`,
      );
    }

    const calendarId =
      input.calendarId ??
      (await provider.calendars(tokens.accessToken)).find((entry) => entry.primary)?.id ??
      'primary';

    return runInTenantTransaction(
      this.dataSource,
      async (scoped) => {
        const connections = scoped.getRepository(CalendarConnection);

        const existing = await connections.findOne({
          where: { tenantId, subject: input.subject, provider: input.provider },
        });

        const row = existing ?? connections.create({ tenantId, subject: input.subject });

        Object.assign(row, {
          provider: input.provider,
          account: tokens.account ?? null,
          calendarId,
          refreshToken: sealSecret(tokens.refreshToken!, this.key),
          accessToken: sealSecret(tokens.accessToken, this.key),
          accessExpiresAt: new Date(tokens.expiresAt),
          state: 'active' as const,
          failures: 0,
          lastError: null,
          syncDueAt: new Date(),
        });

        return viewOf(await connections.save(row));
      },
      { tenantId },
    );
  }

  /** What is connected for one subject. */
  async forSubject(tenantId: string, subject: string): Promise<ConnectionView[]> {
    return runInTenantTransaction(
      this.dataSource,
      async (scoped) => {
        const rows = await scoped.getRepository(CalendarConnection).find({
          where: { tenantId, subject, state: In(['active', 'revoked']) },
          order: { createdAt: 'ASC' },
        });

        return rows.map(viewOf);
      },
      { tenantId },
    );
  }

  /** Everything connected, for a screen that lists them. */
  async list(tenantId: string): Promise<ConnectionView[]> {
    return runInTenantTransaction(
      this.dataSource,
      async (scoped) => {
        const rows = await scoped.getRepository(CalendarConnection).find({
          where: { tenantId, state: In(['active', 'revoked']) },
          order: { subject: 'ASC' },
        });

        return rows.map(viewOf);
      },
      { tenantId },
    );
  }

  /** Which of the calendars on this account somebody could choose. */
  async choices(tenantId: string, connectionId: string) {
    const { connection, accessToken } = await this.usable(tenantId, connectionId);

    return this.providerFor(connection.provider).calendars(accessToken);
  }

  /** Turns one switch or the other on and off. */
  async setDirections(
    tenantId: string,
    connectionId: string,
    directions: { readonly pushes?: boolean; readonly pulls?: boolean },
  ): Promise<ConnectionView> {
    return runInTenantTransaction(
      this.dataSource,
      async (scoped) => {
        const connections = scoped.getRepository(CalendarConnection);

        await connections.update(
          { tenantId, id: connectionId },
          {
            ...(directions.pushes === undefined ? {} : { pushes: directions.pushes }),
            ...(directions.pulls === undefined ? {} : { pulls: directions.pulls }),
          },
        );

        const row = await connections.findOne({ where: { tenantId, id: connectionId } });
        if (!row) throw new NotFoundError('Calendar connection', connectionId);

        return viewOf(row);
      },
      { tenantId },
    );
  }

  /**
   * Disconnects, and takes our copies with us.
   *
   * **The diary is untouched.** Every appointment stays exactly where it was;
   * what goes is the copy out there and our record of it. A best-effort delete,
   * because a person who has already revoked access at the provider cannot be
   * asked to let us tidy up — and refusing to disconnect over it would leave
   * them permanently connected to something that does not work.
   */
  async disconnect(tenantId: string, connectionId: string): Promise<void> {
    const connection = await this.row(tenantId, connectionId);

    try {
      const accessToken = await this.freshToken(tenantId, connection);
      const provider = this.providerFor(connection.provider);

      const links = await runInTenantTransaction(
        this.dataSource,
        (scoped) => scoped.getRepository(CalendarLink).find({ where: { tenantId, connectionId } }),
        { tenantId },
      );

      for (const link of links) {
        await provider
          .remove({
            accessToken,
            calendarId: connection.calendarId,
            externalId: link.externalId,
          })
          .catch(() => undefined);
      }
    } catch {
      // Access already gone. There is nothing to tidy and nothing to say.
    }

    await runInTenantTransaction(
      this.dataSource,
      async (scoped) => {
        await scoped.getRepository(CalendarLink).delete({ tenantId, connectionId });

        /*
         * Marked disconnected rather than deleted, so a second connection for
         * the same subject replaces one row rather than accumulating them —
         * and so the tokens are cleared rather than left lying about.
         */
        await scoped.getRepository(CalendarConnection).update(
          { tenantId, id: connectionId },
          {
            state: 'disconnected',
            refreshToken: '',
            accessToken: null,
            accessExpiresAt: null,
            syncDueAt: null,
          },
        );
      },
      { tenantId },
    );
  }

  /**
   * Writes an appointment out to every calendar that wants it.
   *
   * Silent when nothing is connected, which is the overwhelmingly common case —
   * this is called on every booking write and must cost nothing when the
   * feature is unused.
   */
  async push(tenantId: string, subject: string, appointment: Appointment): Promise<void> {
    const connections = await this.activeFor(tenantId, subject, 'pushes');

    for (const connection of connections) {
      await this.attempt(tenantId, connection, async (accessToken) => {
        const provider = this.providerFor(connection.provider);

        const link = await runInTenantTransaction(
          this.dataSource,
          (scoped) =>
            scoped.getRepository(CalendarLink).findOne({
              where: { tenantId, connectionId: connection.id, subject: appointment.subject },
            }),
          { tenantId },
        );

        if (!shouldPush(appointment, Date.now())) {
          /* Cancelled, or outside the window: the copy goes rather than moves. */
          if (link) {
            await provider.remove({
              accessToken,
              calendarId: connection.calendarId,
              externalId: link.externalId,
            });

            await runInTenantTransaction(
              this.dataSource,
              (scoped) => scoped.getRepository(CalendarLink).delete({ tenantId, id: link.id }),
              { tenantId },
            );
          }

          return;
        }

        const externalId = await provider.upsert({
          accessToken,
          calendarId: connection.calendarId,
          externalId: link?.externalId ?? null,
          startsAt: appointment.startsAt,
          endsAt: appointment.endsAt,
          title: appointment.title,
          ...(appointment.description ? { description: appointment.description } : {}),
          timezone: appointment.timezone,
        });

        await runInTenantTransaction(
          this.dataSource,
          async (scoped) => {
            const links = scoped.getRepository(CalendarLink);
            const row = link ?? links.create({ tenantId, connectionId: connection.id });

            Object.assign(row, {
              subject: appointment.subject,
              externalId,
              startsAt: new Date(appointment.startsAt),
              endsAt: new Date(appointment.endsAt),
              title: appointment.title,
              driftedAt: null,
            });

            await links.save(row);
          },
          { tenantId },
        );
      });
    }
  }

  /**
   * Reads a calendar and returns the busy time it holds.
   *
   * **Also puts back anything somebody edited**, which is the rule: the diary
   * owns appointments and the calendar holds a copy. A stylist who drags an
   * event in Google has not told the customer anything, so the copy is what is
   * wrong.
   */
  async pull(tenantId: string, connectionId: string, now = Date.now()): Promise<PulledBusy | null> {
    const connection = await this.row(tenantId, connectionId);

    if (connection.state !== 'active' || !connection.pulls) return null;

    let pulled: PulledBusy | null = null;

    await this.attempt(tenantId, connection, async (accessToken) => {
      const provider = this.providerFor(connection.provider);
      const window = syncWindow(now);

      const events = await provider.events({
        accessToken,
        calendarId: connection.calendarId,
        from: window.from,
        to: window.to,
      });

      const links = await runInTenantTransaction(
        this.dataSource,
        (scoped) => scoped.getRepository(CalendarLink).find({ where: { tenantId, connectionId } }),
        { tenantId },
      );

      const byId = new Map(events.map((event) => [event.externalId, event]));
      const ours = new Set(links.map((link) => link.externalId));

      /* Anything of ours that has been moved, renamed or deleted out there. */
      for (const link of links) {
        const drift = driftOf(
          {
            externalId: link.externalId,
            startsAt: link.startsAt.getTime(),
            endsAt: link.endsAt.getTime(),
            title: link.title,
          },
          byId.get(link.externalId) ?? null,
        );

        if (drift.kind === 'in-step') continue;

        const externalId = await provider.upsert({
          accessToken,
          calendarId: connection.calendarId,
          externalId: drift.kind === 'deleted' ? null : link.externalId,
          startsAt: link.startsAt.getTime(),
          endsAt: link.endsAt.getTime(),
          title: link.title,
          timezone: 'UTC',
        });

        await runInTenantTransaction(
          this.dataSource,
          (scoped) =>
            scoped
              .getRepository(CalendarLink)
              .update({ tenantId, id: link.id }, { externalId, driftedAt: new Date() }),
          { tenantId },
        );

        ours.add(externalId);
      }

      pulled = {
        connectionId: connection.id,
        subject: connection.subject,
        periods: busyFrom(events, ours),
      };
    });

    return pulled;
  }

  /** Connections that are due a pull, oldest first. */
  async due(tenantId: string, now = new Date()): Promise<ConnectionView[]> {
    return runInTenantTransaction(
      this.dataSource,
      async (scoped) => {
        const rows = await scoped.getRepository(CalendarConnection).find({
          where: { tenantId, state: 'active', syncDueAt: LessThanOrEqual(now) },
          order: { syncDueAt: 'ASC' },
          take: 50,
        });

        return rows.map(viewOf);
      },
      { tenantId },
    );
  }

  /**
   * Runs one operation, and records what it did to the connection's health.
   *
   * A revocation is terminal and is recorded as such; anything else is counted
   * and backed off, because a provider having an afternoon is not a reason to
   * make somebody reconnect.
   */
  private async attempt(
    tenantId: string,
    connection: CalendarConnection,
    work: (accessToken: string) => Promise<void>,
  ): Promise<void> {
    try {
      await work(await this.freshToken(tenantId, connection));

      await runInTenantTransaction(
        this.dataSource,
        (scoped) =>
          scoped.getRepository(CalendarConnection).update(
            { tenantId, id: connection.id },
            {
              failures: 0,
              lastError: null,
              lastSyncedAt: new Date(),
              syncDueAt: new Date(Date.now() + 15 * 60_000),
            },
          ),
        { tenantId },
      );
    } catch (error) {
      const failures = connection.failures + 1;
      const wasRevoked = error instanceof CalendarRevoked;

      await runInTenantTransaction(
        this.dataSource,
        (scoped) =>
          scoped.getRepository(CalendarConnection).update(
            { tenantId, id: connection.id },
            {
              failures,
              lastError: message(error),
              ...(wasRevoked ? { state: 'revoked' as const } : {}),
              /*
               * Backed off, doubling, to an hour. A provider that is refusing
               * is not helped by being asked every minute, and a fleet of
               * workers hammering one is how a temporary problem becomes a
               * suspension.
               */
              syncDueAt: wasRevoked
                ? null
                : new Date(Date.now() + Math.min(60, 2 ** failures) * 60_000),
            },
          ),
        { tenantId },
      );

      if (wasRevoked) return;

      throw error;
    }
  }

  /** A usable access token, refreshed if the stored one has expired. */
  private async freshToken(tenantId: string, connection: CalendarConnection): Promise<string> {
    const stillGood =
      connection.accessToken &&
      connection.accessExpiresAt &&
      /* A minute of margin, because a token that expires mid-request is a
         failure that looks like a revocation. */
      connection.accessExpiresAt.getTime() - 60_000 > Date.now();

    if (stillGood) return openSecret(connection.accessToken!, this.key);

    if (!connection.refreshToken) throw new CalendarRevoked(connection.provider);

    const tokens = await this.providerFor(connection.provider).refresh(
      openSecret(connection.refreshToken, this.key),
    );

    await runInTenantTransaction(
      this.dataSource,
      (scoped) =>
        scoped.getRepository(CalendarConnection).update(
          { tenantId, id: connection.id },
          {
            accessToken: sealSecret(tokens.accessToken, this.key),
            accessExpiresAt: new Date(tokens.expiresAt),
            /*
             * Only when a new one actually arrived. Both providers issue a
             * refresh token once and then stop sending it, so writing
             * `undefined` on every refresh disconnects every calendar within
             * the hour.
             */
            ...(tokens.refreshToken
              ? { refreshToken: sealSecret(tokens.refreshToken, this.key) }
              : {}),
          },
        ),
      { tenantId },
    );

    return tokens.accessToken;
  }

  private async activeFor(
    tenantId: string,
    subject: string,
    direction: 'pushes' | 'pulls',
  ): Promise<CalendarConnection[]> {
    return runInTenantTransaction(
      this.dataSource,
      (scoped) =>
        scoped.getRepository(CalendarConnection).find({
          where: { tenantId, subject, state: 'active', [direction]: true },
        }),
      { tenantId },
    );
  }

  private async row(tenantId: string, connectionId: string): Promise<CalendarConnection> {
    const connection = await runInTenantTransaction(
      this.dataSource,
      (scoped) =>
        scoped.getRepository(CalendarConnection).findOne({ where: { tenantId, id: connectionId } }),
      { tenantId },
    );

    if (!connection) throw new NotFoundError('Calendar connection', connectionId);

    return connection;
  }

  private async usable(
    tenantId: string,
    connectionId: string,
  ): Promise<{ connection: CalendarConnection; accessToken: string }> {
    const connection = await this.row(tenantId, connectionId);

    return { connection, accessToken: await this.freshToken(tenantId, connection) };
  }

  private providerFor(provider: Provider): CalendarProvider {
    const found = this.providers.get(provider);

    if (!found) {
      throw new NotFoundError('Calendar provider', provider);
    }

    return found;
  }
}

function viewOf(connection: CalendarConnection): ConnectionView {
  return {
    id: connection.id,
    subject: connection.subject,
    provider: connection.provider,
    account: connection.account,
    calendarId: connection.calendarId,
    health: healthOf(connection.failures, connection.state === 'revoked'),
    lastSyncedAt: connection.lastSyncedAt?.toISOString() ?? null,
    lastError: connection.lastError,
    pushes: connection.pushes,
    pulls: connection.pulls,
  };
}

const message = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 400);
