import { describe, expect, it } from 'vitest';
import { buildRedisOptions } from './connection';

describe('redis connection options', () => {
  it('applies a command timeout to an ordinary client', () => {
    // A request that hangs should fail rather than hold a request open, which
    // is what this deadline is for everywhere except a queue consumer.
    expect(buildRedisOptions({ url: 'redis://localhost:6379' }).commandTimeout).toBe(5_000);
  });

  it('has no command timeout when one is disabled', () => {
    /*
     * `undefined`, not zero or Infinity.
     *
     * ioredis treats any number as a deadline, so there is no number that
     * means "wait as long as it takes" — the option has to be absent.
     */
    expect(
      buildRedisOptions({ url: 'redis://localhost:6379', commandTimeoutMs: null }).commandTimeout,
    ).toBeUndefined();
  });

  it('parses the database index out of the URL', () => {
    expect(buildRedisOptions({ url: 'redis://localhost:6379/1' }).db).toBe(1);
    expect(buildRedisOptions({ url: 'redis://localhost:6379' }).db).toBe(0);
  });
});
