export interface QuietHours {
  /** Local hour chasing stops, 0–23. */
  from: number;
  /** Local hour it may resume. */
  to: number;
  /**
   * The **firm's** zone, not the client's.
   *
   * The client's is not knowable — a phone number says nothing about where
   * somebody is sitting — and the firm's is the one they would be telephoned
   * from anyway. A Romanian bookkeeper's client in Spain gets an email at nine
   * their time rather than eight, which is a far smaller wrong than 03:00.
   */
  timezone: string;
}

/** Nine to seven, which is when a person is at work and not asleep. */
export const DEFAULT_QUIET_HOURS: QuietHours = {
  from: 19,
  to: 9,
  timezone: 'Europe/Bucharest',
};

/**
 * The local hour and minute at an instant, in a named zone.
 *
 * `Intl` rather than a date library: this is the whole of what is needed, it is
 * in every runtime this code reaches, and the alternative is 70 kB in a bundle
 * that is measured in kilobytes.
 */
export function localTime(at: Date, timezone: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);

  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { hour: value('hour'), minute: value('minute') };
}

/**
 * Whether a message would arrive when nobody wants one.
 *
 * Handles the ordinary case (quiet from 19:00 to 09:00, which wraps midnight)
 * and the inverted one a firm could configure by mistake. A window that wraps
 * is the normal shape here, so it is the branch that gets the reasoning.
 */
export function isQuiet(at: Date, quiet: QuietHours): boolean {
  const { hour } = localTime(at, quiet.timezone);

  // The window does not wrap: quiet from 01:00 to 06:00, say.
  if (quiet.from < quiet.to) return hour >= quiet.from && hour < quiet.to;

  // The usual case: quiet from the evening until the next morning.
  return hour >= quiet.from || hour < quiet.to;
}

/**
 * The next moment a message may be sent.
 *
 * Deferred to the start of the working day rather than to the exact end of the
 * quiet window plus a second: forty clients whose reminders all came due
 * overnight would otherwise be messaged in one burst at 09:00:00, which reads
 * as a machine. The dispatcher spreads them; this only says when it may begin.
 */
export function nextAllowed(at: Date, quiet: QuietHours): Date {
  if (!isQuiet(at, quiet)) return at;

  const candidate = new Date(at);
  // Minute by minute would be exact and needless; the hour is the unit the
  // window is expressed in, and at most 24 steps is nothing.
  for (let step = 0; step < 48; step += 1) {
    candidate.setUTCMinutes(0, 0, 0);
    candidate.setUTCHours(candidate.getUTCHours() + 1);
    if (!isQuiet(candidate, quiet)) return candidate;
  }

  /*
   * A window that is quiet around the clock.
   *
   * `from === to` configures exactly that, and a firm can do it by mistake.
   * Refusing to loop for ever and sending anyway is the lesser wrong: a
   * reminder at an awkward hour is recoverable, and a request that is never
   * chased at all is the thing the product was bought to prevent.
   */
  return at;
}
