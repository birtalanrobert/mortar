import type { CalendarEvent, Provider } from '../sync';

/**
 * What a calendar provider has to be able to do.
 *
 * Four operations, and the list is short on purpose: everything clever about
 * this feature is in the rules, and a provider that needed a fifth would be one
 * whose peculiarities had leaked into them.
 *
 * The adapters live behind `/google` and `/microsoft` so a product using one
 * does not install the other's SDK — Google's client alone is several megabytes
 * and a worker that only speaks to Microsoft should not carry it.
 */
export interface CalendarProvider {
  readonly name: Provider;

  /**
   * Where to send somebody to say yes.
   *
   * `state` is ours and comes back untouched; it is how the callback knows
   * which staff member it is for, and it is signed by the caller rather than
   * trusted — a callback is a URL anybody can invent.
   */
  authorizeUrl(input: { readonly state: string; readonly redirectUri: string }): string;

  /** Turns the code from a callback into tokens we can hold. */
  exchange(input: { readonly code: string; readonly redirectUri: string }): Promise<CalendarTokens>;

  /** A fresh access token, from the refresh token we were given. */
  refresh(refreshToken: string): Promise<CalendarTokens>;

  /** Their events in a window, as the rules describe them. */
  events(input: {
    readonly accessToken: string;
    readonly calendarId: string;
    readonly from: number;
    readonly to: number;
  }): Promise<CalendarEvent[]>;

  /** Writes or rewrites our copy of an appointment. Returns its identifier. */
  upsert(input: {
    readonly accessToken: string;
    readonly calendarId: string;
    readonly externalId: string | null;
    readonly startsAt: number;
    readonly endsAt: number;
    readonly title: string;
    readonly description?: string;
    readonly timezone: string;
  }): Promise<string>;

  /** Removes our copy. Silent when it is already gone. */
  remove(input: {
    readonly accessToken: string;
    readonly calendarId: string;
    readonly externalId: string;
  }): Promise<void>;

  /** Which calendars this account has, so somebody can pick one. */
  calendars(accessToken: string): Promise<Array<{ id: string; name: string; primary: boolean }>>;
}

export interface CalendarTokens {
  readonly accessToken: string;
  /**
   * Absent on a refresh, and that is normal.
   *
   * Both providers issue a refresh token once and then stop sending it. A
   * caller that overwrote the stored one with `undefined` on every refresh
   * would disconnect every calendar within an hour — which is the bug this
   * comment exists to prevent.
   */
  readonly refreshToken?: string;
  readonly expiresAt: number;
  /** The account this is, so a screen can say whose calendar it is. */
  readonly account?: string;
}

/**
 * Access was withdrawn, rather than a request having failed.
 *
 * A separate error because the response is different: a failure is retried and
 * a revocation is not — there is nothing to retry with, and the person has to
 * be asked again.
 */
export class CalendarRevoked extends Error {
  constructor(readonly provider: Provider) {
    super(`The ${provider} calendar connection was revoked.`);
    this.name = 'CalendarRevoked';
  }
}
