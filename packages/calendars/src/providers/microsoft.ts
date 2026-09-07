import { Client } from '@microsoft/microsoft-graph-client';
import type { CalendarEvent } from '../sync';
import { CalendarRevoked, type CalendarProvider, type CalendarTokens } from './port';

/**
 * Outlook and Microsoft 365, through Microsoft Graph's own client.
 *
 * Graph rather than the old Outlook REST API, and the official client rather
 * than requests: it handles the paging header, the retry semantics and the
 * throttling responses, all of which are things this file would otherwise get
 * subtly wrong for a year.
 */
export interface MicrosoftCalendarOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  /**
   * Which directory to authenticate against.
   *
   * `common` for anybody with a Microsoft account, personal or work. A single
   * tenant identifier locks it to one organisation, which is right for an
   * internal deployment and wrong for a product sold to salons.
   */
  readonly tenant?: string;
}

/**
 * Read and write the signed-in person's calendar, and keep working offline.
 *
 * `offline_access` is what yields a refresh token; without it the connection
 * lasts an hour and then quietly stops, which reads as our bug.
 */
const SCOPES = ['offline_access', 'openid', 'email', 'Calendars.ReadWrite'];

const AUTHORITY = 'https://login.microsoftonline.com';

export class MicrosoftCalendar implements CalendarProvider {
  readonly name = 'microsoft' as const;

  constructor(private readonly options: MicrosoftCalendarOptions) {}

  authorizeUrl(input: { state: string; redirectUri: string }): string {
    const query = new URLSearchParams({
      client_id: this.options.clientId,
      response_type: 'code',
      redirect_uri: input.redirectUri,
      response_mode: 'query',
      scope: SCOPES.join(' '),
      state: input.state,
    });

    return `${AUTHORITY}/${this.options.tenant ?? 'common'}/oauth2/v2.0/authorize?${query}`;
  }

  async exchange(input: { code: string; redirectUri: string }): Promise<CalendarTokens> {
    return this.token({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
    });
  }

  async refresh(refreshToken: string): Promise<CalendarTokens> {
    return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  async events(input: {
    accessToken: string;
    calendarId: string;
    from: number;
    to: number;
  }): Promise<CalendarEvent[]> {
    /*
     * `calendarView`, not `events`.
     *
     * The difference matters: `events` returns a recurring meeting as one
     * master with a rule attached, and `calendarView` expands it into the
     * occurrences that actually fall in the window. Reading the wrong one gives
     * a diary that ignores every weekly meeting somebody has.
     */
    const found: CalendarEvent[] = [];

    let path: string | undefined =
      `/me/calendars/${input.calendarId}/calendarView` +
      `?startDateTime=${new Date(input.from).toISOString()}` +
      `&endDateTime=${new Date(input.to).toISOString()}` +
      `&$select=id,subject,start,end,showAs,isCancelled,type&$top=200`;

    const client = this.client(input.accessToken);

    while (path) {
      const page: {
        value?: GraphEvent[];
        '@odata.nextLink'?: string;
      } = await client.api(path).get();

      for (const event of page.value ?? []) {
        const parsed = toEvent(event);
        if (parsed) found.push(parsed);
      }

      path = page['@odata.nextLink'];
    }

    return found;
  }

  async upsert(input: {
    accessToken: string;
    calendarId: string;
    externalId: string | null;
    startsAt: number;
    endsAt: number;
    title: string;
    description?: string;
    /** Carried for Google's sake; Graph is sent UTC. See below. */
    timezone: string;
  }): Promise<string> {
    void input.timezone;

    const client = this.client(input.accessToken);

    const body = {
      subject: input.title,
      ...(input.description ? { body: { contentType: 'text', content: input.description } } : {}),
      /*
       * Sent as UTC, and labelled as UTC.
       *
       * Graph wants a *naive local* time plus the zone it is in, so sending the
       * UTC wall clock under the business's own zone name shifts every event by
       * that zone's offset — a Bucharest salon's two o'clock written out as
       * five. UTC is unambiguous, Outlook renders it in the viewer's zone
       * anyway, and there is no arithmetic to get wrong.
       */
      start: { dateTime: utcNaive(input.startsAt), timeZone: 'UTC' },
      end: { dateTime: utcNaive(input.endsAt), timeZone: 'UTC' },
      showAs: 'busy',
      /*
       * Nobody is invited and no reminder is set: this is a copy of a diary for
       * the person who owns the calendar, not an invitation to a customer.
       */
      attendees: [],
      isReminderOn: false,
    };

    if (input.externalId) {
      try {
        const updated: GraphEvent = await client.api(`/me/events/${input.externalId}`).patch(body);

        return updated.id ?? input.externalId;
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }

    const created: GraphEvent = await client
      .api(`/me/calendars/${input.calendarId}/events`)
      .post(body);

    if (!created.id) throw new Error('Microsoft created an event with no identifier.');

    return created.id;
  }

  async remove(input: {
    accessToken: string;
    calendarId: string;
    externalId: string;
  }): Promise<void> {
    try {
      await this.client(input.accessToken).api(`/me/events/${input.externalId}`).delete();
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }

  async calendars(accessToken: string) {
    const page: { value?: Array<{ id?: string; name?: string; isDefaultCalendar?: boolean }> } =
      await this.client(accessToken).api('/me/calendars?$select=id,name,isDefaultCalendar').get();

    return (page.value ?? [])
      .filter((entry) => entry.id)
      .map((entry) => ({
        id: entry.id!,
        name: entry.name ?? entry.id!,
        primary: entry.isDefaultCalendar === true,
      }));
  }

  private client(accessToken: string): Client {
    return Client.init({ authProvider: (done) => done(null, accessToken) });
  }

  /**
   * The token endpoint, by hand.
   *
   * The Graph client is a client for the API rather than for the sign-in
   * endpoint, and Microsoft's own auth library is a large dependency for one
   * form post. Everything that touches *calendar data* goes through the SDK.
   */
  private async token(fields: Record<string, string>): Promise<CalendarTokens> {
    const body = new URLSearchParams({
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
      scope: SCOPES.join(' '),
      ...fields,
    });

    const response = await fetch(
      `${AUTHORITY}/${this.options.tenant ?? 'common'}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      },
    );

    if (!response.ok) {
      /*
       * `invalid_grant` is a withdrawn consent rather than a failure, and the
       * two need different responses: one is retried and the other cannot be,
       * because there is nothing left to retry with.
       */
      const detail = await response.text();

      if (response.status === 400 && detail.includes('invalid_grant')) {
        throw new CalendarRevoked('microsoft');
      }

      throw new Error(`Microsoft refused the token request: ${response.status}`);
    }

    const tokens = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      id_token?: string;
    };

    if (!tokens.access_token) throw new CalendarRevoked('microsoft');

    return {
      accessToken: tokens.access_token,
      ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
      expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      ...(addressIn(tokens.id_token) ? { account: addressIn(tokens.id_token)! } : {}),
    };
  }
}

interface GraphEvent {
  id?: string;
  subject?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  showAs?: string;
  isCancelled?: boolean;
  type?: string;
}

/**
 * One of Graph's events, as the rules describe them.
 *
 * Graph returns a naive local time plus a zone name rather than an instant, so
 * the zone has to be appended before parsing — `2026-06-15T09:00:00.0000000`
 * parsed on its own is nine o'clock wherever the *server* happens to be, which
 * is how a London salon's diary ends up an hour out in summer.
 */
function toEvent(event: GraphEvent): CalendarEvent | null {
  if (!event.id || !event.start?.dateTime || !event.end?.dateTime) return null;

  const startsAt = instantOf(event.start.dateTime, event.start.timeZone);
  const endsAt = instantOf(event.end.dateTime, event.end.timeZone);

  if (Number.isNaN(startsAt) || Number.isNaN(endsAt)) return null;

  return {
    externalId: event.id,
    startsAt,
    endsAt,
    title: event.subject ?? '',
    // `free` and `workingElsewhere` are both "you may book me".
    busy: event.showAs !== 'free' && event.showAs !== 'workingElsewhere',
    cancelled: event.isCancelled === true,
  };
}

/**
 * Graph's local-time-plus-zone, as an instant.
 *
 * The request asks for UTC by default, so the ordinary case is a `Z` away. A
 * named zone is converted properly rather than guessed at, because guessing is
 * an hour of somebody's day.
 */
export function instantOf(dateTime: string, timeZone?: string): number {
  if (!timeZone || timeZone === 'UTC') {
    return Date.parse(dateTime.endsWith('Z') ? dateTime : `${dateTime}Z`);
  }

  const naive = dateTime.replace(/Z$/, '');
  const guess = Date.parse(`${naive}Z`);

  if (Number.isNaN(guess)) return Number.NaN;

  /*
   * The offset that zone had at that moment, applied backwards. Two passes,
   * because the offset itself depends on the instant — the hour the clocks go
   * back is the one this gets wrong in a single pass.
   */
  let instant = guess;

  for (let pass = 0; pass < 2; pass += 1) {
    instant = guess + offsetOf(timeZone, instant);
  }

  return instant;
}

function offsetOf(timeZone: string, instant: number): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(instant));

    const at = (type: string): string => parts.find((part) => part.type === type)?.value ?? '00';

    const local = Date.UTC(
      Number(at('year')),
      Number(at('month')) - 1,
      Number(at('day')),
      Number(at('hour')) % 24,
      Number(at('minute')),
      Number(at('second')),
    );

    return instant - local;
  } catch {
    // An unknown zone name is treated as UTC rather than as a failure: an
    // event in the wrong hour is better than a sync that stops entirely.
    return 0;
  }
}

/** The address inside an identity token, read without verifying it. */
function addressIn(idToken?: string): string | undefined {
  if (!idToken) return undefined;

  try {
    const payload = idToken.split('.')[1];
    if (!payload) return undefined;

    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      email?: string;
      preferred_username?: string;
    };

    /*
     * Not verified, and it does not need to be: this token came straight from
     * Microsoft's own token endpoint over TLS, and the value is used as a label
     * on a screen rather than as a credential.
     */
    return claims.email ?? claims.preferred_username;
  } catch {
    return undefined;
  }
}

/** Graph's format: an ISO instant with the zone suffix stripped off. */
const utcNaive = (at: number): string => new Date(at).toISOString().replace('Z', '');

const missing = (error: unknown): boolean => {
  const code =
    (error as { statusCode?: number }).statusCode ?? (error as { status?: number }).status;

  return code === 404 || code === 410;
};
