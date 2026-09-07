import { google, type calendar_v3 } from 'googleapis';
import type { CalendarEvent } from '../sync';
import { CalendarRevoked, type CalendarProvider, type CalendarTokens } from './port';

/**
 * Google Calendar, through Google's own client.
 *
 * The official SDK rather than hand-rolled requests: token refresh, retries and
 * the several ways Google spells a date are all things somebody has already got
 * right, and getting them subtly wrong here would show up as appointments an
 * hour out in one timezone.
 */
export interface GoogleCalendarOptions {
  readonly clientId: string;
  readonly clientSecret: string;
}

/**
 * Read and write one calendar, and see the list.
 *
 * `calendar.events` rather than the whole of `calendar`: the narrower scope is
 * what Google's verification asks about, and a product that only needs to add
 * events should not be asking to delete somebody's calendars.
 */
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
];

export class GoogleCalendar implements CalendarProvider {
  readonly name = 'google' as const;

  constructor(private readonly options: GoogleCalendarOptions) {}

  authorizeUrl(input: { state: string; redirectUri: string }): string {
    return this.client(input.redirectUri).generateAuthUrl({
      /*
       * Offline, and consent forced.
       *
       * Google issues a refresh token **only** on the first consent unless
       * `prompt=consent` is sent — so a person who reconnects after
       * disconnecting gets an access token, no refresh token, and a connection
       * that dies in an hour. The failure looks like our bug and is this flag.
       */
      access_type: 'offline',
      prompt: 'consent',
      scope: SCOPES,
      state: input.state,
      include_granted_scopes: true,
    });
  }

  async exchange(input: { code: string; redirectUri: string }): Promise<CalendarTokens> {
    const client = this.client(input.redirectUri);
    const { tokens } = await client.getToken(input.code);

    if (!tokens.access_token) {
      throw new Error('Google returned no access token.');
    }

    client.setCredentials(tokens);

    /* Whose calendar this is, so a screen can say so. */
    let account: string | undefined;

    try {
      const me = await google.oauth2({ version: 'v2', auth: client }).userinfo.get();
      account = me.data.email ?? undefined;
    } catch {
      // A missing address is a nicety. Failing the connection over it would be
      // refusing a working calendar because we could not label it.
    }

    return {
      accessToken: tokens.access_token,
      ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
      expiresAt: tokens.expiry_date ?? Date.now() + 3_600_000,
      ...(account ? { account } : {}),
    };
  }

  async refresh(refreshToken: string): Promise<CalendarTokens> {
    const client = this.client();
    client.setCredentials({ refresh_token: refreshToken });

    try {
      const { credentials } = await client.refreshAccessToken();

      if (!credentials.access_token) throw new CalendarRevoked('google');

      return {
        accessToken: credentials.access_token,
        // Absent on a refresh, which is normal: Google issues one and stops.
        // Overwriting the stored one with `undefined` disconnects the calendar
        // within the hour.
        ...(credentials.refresh_token ? { refreshToken: credentials.refresh_token } : {}),
        expiresAt: credentials.expiry_date ?? Date.now() + 3_600_000,
      };
    } catch (error) {
      throw revoked(error) ? new CalendarRevoked('google') : error;
    }
  }

  async events(input: {
    accessToken: string;
    calendarId: string;
    from: number;
    to: number;
  }): Promise<CalendarEvent[]> {
    const api = this.api(input.accessToken);
    const found: CalendarEvent[] = [];

    let pageToken: string | undefined;

    do {
      const page = await api.events.list({
        calendarId: input.calendarId,
        timeMin: new Date(input.from).toISOString(),
        timeMax: new Date(input.to).toISOString(),
        /*
         * Expanded, so a weekly meeting is fifty-two busy periods rather than
         * one rule this code would have to interpret. Recurrence is a language,
         * and the provider already speaks it.
         */
        singleEvents: true,
        showDeleted: true,
        maxResults: 250,
        ...(pageToken ? { pageToken } : {}),
      });

      for (const event of page.data.items ?? []) {
        const parsed = toEvent(event);
        if (parsed) found.push(parsed);
      }

      pageToken = page.data.nextPageToken ?? undefined;
    } while (pageToken);

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
    timezone: string;
  }): Promise<string> {
    const api = this.api(input.accessToken);

    const body: calendar_v3.Schema$Event = {
      summary: input.title,
      ...(input.description ? { description: input.description } : {}),
      start: { dateTime: new Date(input.startsAt).toISOString(), timeZone: input.timezone },
      end: { dateTime: new Date(input.endsAt).toISOString(), timeZone: input.timezone },
      /*
       * Nobody is invited, and no reminder is set.
       *
       * This is a copy of a diary for the person who owns the calendar, not an
       * invitation to a customer — sending one would email somebody a meeting
       * request for a haircut they already booked.
       */
      attendees: [],
      reminders: { useDefault: false, overrides: [] },
    };

    if (input.externalId) {
      try {
        const updated = await api.events.update({
          calendarId: input.calendarId,
          eventId: input.externalId,
          requestBody: body,
        });

        return updated.data.id ?? input.externalId;
      } catch (error) {
        // Deleted out there since we last looked. Writing it again is the rule:
        // the diary owns the appointment.
        if (!missing(error)) throw error;
      }
    }

    const created = await api.events.insert({
      calendarId: input.calendarId,
      requestBody: body,
    });

    if (!created.data.id) throw new Error('Google created an event with no identifier.');

    return created.data.id;
  }

  async remove(input: {
    accessToken: string;
    calendarId: string;
    externalId: string;
  }): Promise<void> {
    try {
      await this.api(input.accessToken).events.delete({
        calendarId: input.calendarId,
        eventId: input.externalId,
      });
    } catch (error) {
      // Already gone is the outcome we wanted.
      if (!missing(error)) throw error;
    }
  }

  async calendars(accessToken: string) {
    const list = await this.api(accessToken).calendarList.list({ maxResults: 100 });

    return (list.data.items ?? [])
      .filter((entry) => entry.id)
      .map((entry) => ({
        id: entry.id!,
        name: entry.summary ?? entry.id!,
        primary: entry.primary === true,
      }));
  }

  private client(redirectUri?: string) {
    return new google.auth.OAuth2(this.options.clientId, this.options.clientSecret, redirectUri);
  }

  private api(accessToken: string): calendar_v3.Calendar {
    const auth = this.client();
    auth.setCredentials({ access_token: accessToken });

    return google.calendar({ version: 'v3', auth });
  }
}

/**
 * One of Google's events, as the rules describe them.
 *
 * All-day events are skipped rather than treated as busy: a birthday or a
 * public holiday marked across a whole day would otherwise close the diary, and
 * "somebody's calendar says it is Tuesday" is not a reason to refuse bookings.
 */
function toEvent(event: calendar_v3.Schema$Event): CalendarEvent | null {
  if (!event.id) return null;

  const start = event.start?.dateTime;
  const end = event.end?.dateTime;

  if (!start || !end) return null;

  return {
    externalId: event.id,
    startsAt: Date.parse(start),
    endsAt: Date.parse(end),
    title: event.summary ?? '',
    // `transparent` is Google's word for "I am free during this".
    busy: event.transparency !== 'transparent',
    cancelled: event.status === 'cancelled',
  };
}

const status = (error: unknown): number | undefined =>
  (error as { code?: number; status?: number }).code ??
  (error as { response?: { status?: number } }).response?.status;

const missing = (error: unknown): boolean => {
  const code = status(error);
  return code === 404 || code === 410;
};

const revoked = (error: unknown): boolean => {
  const code = status(error);
  return code === 400 || code === 401;
};
