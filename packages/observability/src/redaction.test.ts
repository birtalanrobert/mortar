import { describe, expect, it } from 'vitest';
import { REDACTED, safeUrl } from './redaction';

describe('a URL safe to write down', () => {
  it('strips a signed link’s token, keeping the path', () => {
    /*
     * The exposure this closes. A signed link is often the *only* credential a
     * customer without an account has, and it was being written into the
     * request log in full — so anybody who could read the logs could read, move
     * or cancel the booking it points at.
     */
    expect(safeUrl('/api/public/bookings/by-link?token=eyJhbGciOi.abc')).toBe(
      `/api/public/bookings/by-link?token=${REDACTED}`,
    );
  });

  it('keeps the parameters somebody debugs from', () => {
    // A log line with the query stripped entirely is one nobody can use.
    expect(safeUrl('/api/availability?serviceId=abc&from=2026-03-02')).toBe(
      '/api/availability?serviceId=abc&from=2026-03-02',
    );
  });

  it('strips every name a credential travels under', () => {
    for (const name of ['token', 'access_token', 'code', 'secret', 'api_key', 'signature']) {
      expect(safeUrl(`/x?${name}=value`)).toBe(`/x?${name}=${REDACTED}`);
    }
  });

  it('matches the whole parameter name, not a fragment of it', () => {
    // Otherwise `tokenCount` and `keyword` become unreadable for no gain.
    expect(safeUrl('/x?tokenCount=3&keyword=hair')).toBe('/x?tokenCount=3&keyword=hair');
  });

  it('leaves a URL with no query alone, and never throws on a broken one', () => {
    // This runs on the logging path of every request; a logger that throws is
    // worse than one that logs a little too much.
    expect(safeUrl('/api/health')).toBe('/api/health');
    expect(safeUrl(undefined)).toBeUndefined();
    expect(safeUrl('/x?%')).toBe('/x?%');
    expect(safeUrl('/x?%=1')).toBe('/x?%=1');
    expect(safeUrl('/x/%/y', { token: 'z' })).toBe('/x/%/y');
  });

  it('strips a credential that is a segment of the path, given the route’s parameters', () => {
    /*
     * A share link's token is as often in the path — `/reports/shared/:token`
     * — as in the query, and the framework hands the logger the URL with the
     * segment filled in. The route's parameters say which segment it is.
     */
    expect(
      safeUrl('/api/worlds/w1/reports/shared/eyJ.abc%2Fdef?page=2', {
        worldId: 'w1',
        token: 'eyJ.abc/def',
      }),
    ).toBe(`/api/worlds/w1/reports/shared/${REDACTED}?page=2`);
    // An ordinary parameter, or none, leaves the path as it is.
    expect(safeUrl('/api/worlds/w1/villages/v1', { worldId: 'w1', villageId: 'v1' })).toBe(
      '/api/worlds/w1/villages/v1',
    );
    expect(safeUrl('/api/worlds/w1', {})).toBe('/api/worlds/w1');
  });
});
