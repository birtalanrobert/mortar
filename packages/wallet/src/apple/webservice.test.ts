import { beforeEach, describe, expect, it } from 'vitest';
import {
  deviceLog,
  fetchPass,
  passesUpdatedSince,
  registerDevice,
  unregisterDevice,
  type PassRecord,
  type PassSource,
  type ProtocolOptions,
  type RegistrationStore,
} from './webservice';

/**
 * The protocol, against a source and a store held in memory.
 *
 * The product's end-to-end suite runs the same conversation over HTTP against a
 * real database; this runs it over the functions, where the cases that are hard
 * to arrange — two updates inside one second, a tag from before both — cost
 * nothing to set up.
 */

const PASS_TYPE = 'pass.ro.stamped.loyalty';

interface Stored extends PassRecord {
  /** The monotonic tag, which is the whole subject of §5.6. */
  sequence: number;
  bytes: string;
}

class MemorySource implements PassSource {
  readonly passes = new Map<string, Stored>();
  private next = 0;

  issue(serialNumber: string, bytes = 'a pass'): Stored {
    this.next += 1;
    const pass: Stored = {
      passTypeIdentifier: PASS_TYPE,
      serialNumber,
      tokenVersion: 1,
      updatedAt: new Date('2026-06-01T09:00:00Z'),
      voided: false,
      sequence: this.next,
      bytes,
    };
    this.passes.set(serialNumber, pass);
    return pass;
  }

  /** A content change: new bytes, a new sequence, a new timestamp. */
  update(serialNumber: string, bytes: string, at = new Date('2026-06-02T09:00:00Z')): void {
    const pass = this.passes.get(serialNumber);
    if (!pass) throw new Error(`no such pass ${serialNumber}`);
    this.next += 1;
    pass.sequence = this.next;
    pass.bytes = bytes;
    pass.updatedAt = at;
  }

  find(passTypeIdentifier: string, serialNumber: string): Promise<PassRecord | null> {
    if (passTypeIdentifier !== PASS_TYPE) return Promise.resolve(null);
    return Promise.resolve(this.passes.get(serialNumber) ?? null);
  }

  build(pass: PassRecord): Promise<Buffer> {
    return Promise.resolve(Buffer.from(this.passes.get(pass.serialNumber)?.bytes ?? ''));
  }

  updatedSince(
    _passTypeIdentifier: string,
    serialNumbers: readonly string[],
    since: string | undefined,
  ): Promise<{ serialNumbers: string[]; lastUpdated: string }> {
    const tag = since ? Number(since) : 0;
    const changed = serialNumbers
      .map((serial) => this.passes.get(serial))
      .filter((pass): pass is Stored => Boolean(pass) && pass!.sequence > tag);

    const lastUpdated = changed.reduce((highest, pass) => Math.max(highest, pass.sequence), tag);

    return Promise.resolve({
      serialNumbers: changed.map((pass) => pass.serialNumber),
      lastUpdated: String(lastUpdated),
    });
  }
}

class MemoryStore implements RegistrationStore {
  readonly rows: Array<{
    deviceLibraryIdentifier: string;
    pushToken: string;
    passTypeIdentifier: string;
    serialNumber: string;
  }> = [];

  add(input: {
    deviceLibraryIdentifier: string;
    pushToken: string;
    passTypeIdentifier: string;
    serialNumber: string;
  }): Promise<boolean> {
    const existing = this.rows.find(
      (row) =>
        row.deviceLibraryIdentifier === input.deviceLibraryIdentifier &&
        row.passTypeIdentifier === input.passTypeIdentifier &&
        row.serialNumber === input.serialNumber,
    );

    if (existing) {
      existing.pushToken = input.pushToken;
      return Promise.resolve(false);
    }

    this.rows.push({ ...input });
    return Promise.resolve(true);
  }

  remove(input: {
    deviceLibraryIdentifier: string;
    passTypeIdentifier: string;
    serialNumber: string;
  }): Promise<boolean> {
    const at = this.rows.findIndex(
      (row) =>
        row.deviceLibraryIdentifier === input.deviceLibraryIdentifier &&
        row.passTypeIdentifier === input.passTypeIdentifier &&
        row.serialNumber === input.serialNumber,
    );

    if (at === -1) return Promise.resolve(false);
    this.rows.splice(at, 1);
    return Promise.resolve(true);
  }

  serialsFor(deviceLibraryIdentifier: string, passTypeIdentifier: string): Promise<string[]> {
    return Promise.resolve(
      this.rows
        .filter(
          (row) =>
            row.deviceLibraryIdentifier === deviceLibraryIdentifier &&
            row.passTypeIdentifier === passTypeIdentifier,
        )
        .map((row) => row.serialNumber),
    );
  }

  devicesFor(
    passTypeIdentifier: string,
    serialNumber: string,
  ): Promise<Array<{ deviceLibraryIdentifier: string; pushToken: string }>> {
    return Promise.resolve(
      this.rows
        .filter(
          (row) =>
            row.passTypeIdentifier === passTypeIdentifier && row.serialNumber === serialNumber,
        )
        .map((row) => ({
          deviceLibraryIdentifier: row.deviceLibraryIdentifier,
          pushToken: row.pushToken,
        })),
    );
  }
}

let source: MemorySource;
let registrations: MemoryStore;
let options: ProtocolOptions;

const GOOD = 'the-right-token';

beforeEach(() => {
  source = new MemorySource();
  registrations = new MemoryStore();
  options = {
    source,
    registrations,
    authorise: (_pass, presented) => presented === GOOD,
  };
});

describe('registering a device', () => {
  it('is 201 the first time and 200 the next', async () => {
    source.issue('card-1');

    const first = await registerDevice(options, {
      deviceLibraryIdentifier: 'device-1',
      passTypeIdentifier: PASS_TYPE,
      serialNumber: 'card-1',
      pushToken: 'push-1',
      token: GOOD,
    });

    /*
     * Apple's own documentation draws the distinction and devices rely on it: a
     * 201 for a registration that already existed makes a device that retried
     * look like a device that installed the pass twice.
     */
    expect(first.status).toBe(201);

    const again = await registerDevice(options, {
      deviceLibraryIdentifier: 'device-1',
      passTypeIdentifier: PASS_TYPE,
      serialNumber: 'card-1',
      pushToken: 'push-1',
      token: GOOD,
    });

    expect(again.status).toBe(200);
    expect(registrations.rows).toHaveLength(1);
  });

  /**
   * The case that quietly breaks a product six months in.
   *
   * A device that reinstalls the pass, or whose APNs token is reissued, calls
   * this again with the same identifiers and a **different** token. Keeping the
   * old one means pushing into the void for ever — and recording every one of
   * them as delivered.
   */
  it('takes the new push token when a device re-registers', async () => {
    source.issue('card-1');

    for (const pushToken of ['push-old', 'push-new']) {
      await registerDevice(options, {
        deviceLibraryIdentifier: 'device-1',
        passTypeIdentifier: PASS_TYPE,
        serialNumber: 'card-1',
        pushToken,
        token: GOOD,
      });
    }

    expect(registrations.rows).toHaveLength(1);
    expect(registrations.rows[0]?.pushToken).toBe('push-new');
  });

  it('is 401 for the wrong token and 404 for a pass that is not there', async () => {
    source.issue('card-1');

    const wrong = await registerDevice(options, {
      deviceLibraryIdentifier: 'device-1',
      passTypeIdentifier: PASS_TYPE,
      serialNumber: 'card-1',
      pushToken: 'push-1',
      token: 'a-guess',
    });
    expect(wrong.status).toBe(401);

    const missing = await registerDevice(options, {
      deviceLibraryIdentifier: 'device-1',
      passTypeIdentifier: PASS_TYPE,
      serialNumber: 'no-such-card',
      pushToken: 'push-1',
      token: GOOD,
    });
    expect(missing.status).toBe(404);

    expect(registrations.rows).toHaveLength(0);
  });
});

describe('deregistering', () => {
  it('removes the registration', async () => {
    source.issue('card-1');
    await registerDevice(options, {
      deviceLibraryIdentifier: 'device-1',
      passTypeIdentifier: PASS_TYPE,
      serialNumber: 'card-1',
      pushToken: 'push-1',
      token: GOOD,
    });

    const result = await unregisterDevice(options, {
      deviceLibraryIdentifier: 'device-1',
      passTypeIdentifier: PASS_TYPE,
      serialNumber: 'card-1',
      token: GOOD,
    });

    expect(result.status).toBe(200);
    expect(registrations.rows).toHaveLength(0);
  });

  it('is 200 again on a retry, rather than an error', async () => {
    source.issue('card-1');

    // A device that retries a deregistration has not made a mistake, and
    // telling it otherwise makes it retry harder.
    const result = await unregisterDevice(options, {
      deviceLibraryIdentifier: 'device-1',
      passTypeIdentifier: PASS_TYPE,
      serialNumber: 'card-1',
      token: GOOD,
    });

    expect(result.status).toBe(200);
  });

  it('refuses a guess', async () => {
    source.issue('card-1');
    await registerDevice(options, {
      deviceLibraryIdentifier: 'device-1',
      passTypeIdentifier: PASS_TYPE,
      serialNumber: 'card-1',
      pushToken: 'push-1',
      token: GOOD,
    });

    const result = await unregisterDevice(options, {
      deviceLibraryIdentifier: 'device-1',
      passTypeIdentifier: PASS_TYPE,
      serialNumber: 'card-1',
      token: 'a-guess',
    });

    expect(result.status).toBe(401);
    expect(registrations.rows).toHaveLength(1);
  });
});

describe('asking what changed', () => {
  const register = async (serial: string, device = 'device-1') => {
    source.issue(serial);
    await registerDevice(options, {
      deviceLibraryIdentifier: device,
      passTypeIdentifier: PASS_TYPE,
      serialNumber: serial,
      pushToken: `push-${device}`,
      token: GOOD,
    });
  };

  it('is 404 for a device that holds nothing', async () => {
    const result = await passesUpdatedSince(options, {
      deviceLibraryIdentifier: 'a-stranger',
      passTypeIdentifier: PASS_TYPE,
      since: undefined,
    });

    expect(result.status).toBe(404);
  });

  it('is 204 when nothing has changed since the tag', async () => {
    await register('card-1');

    const first = await passesUpdatedSince(options, {
      deviceLibraryIdentifier: 'device-1',
      passTypeIdentifier: PASS_TYPE,
      since: undefined,
    });
    expect(first.status).toBe(200);

    const tag = (first.body as { lastUpdated: string }).lastUpdated;

    /*
     * The answer a device gets most of the time, and the one implementations
     * most often get wrong by returning 200 with an empty array.
     */
    const again = await passesUpdatedSince(options, {
      deviceLibraryIdentifier: 'device-1',
      passTypeIdentifier: PASS_TYPE,
      since: tag,
    });
    expect(again.status).toBe(204);
  });

  /**
   * The bug §5.6 exists to prevent, written as a test.
   *
   * With a tag taken from a clock, two updates inside the same tick share a
   * value: the device stores it after the first, asks again, is told nothing
   * changed, and keeps a pass that has silently stopped matching the database.
   * A monotonic sequence cannot do that, and this is what proves it.
   */
  it('reports both of two updates that happen in the same instant', async () => {
    await register('card-1');
    await register('card-2');

    const start = await passesUpdatedSince(options, {
      deviceLibraryIdentifier: 'device-1',
      passTypeIdentifier: PASS_TYPE,
      since: undefined,
    });
    const tag = (start.body as { lastUpdated: string }).lastUpdated;

    const sameInstant = new Date('2026-06-02T09:00:00.000Z');
    source.update('card-1', 'eight stamps', sameInstant);
    source.update('card-2', 'three stamps', sameInstant);

    const result = await passesUpdatedSince(options, {
      deviceLibraryIdentifier: 'device-1',
      passTypeIdentifier: PASS_TYPE,
      since: tag,
    });

    expect(result.status).toBe(200);
    expect((result.body as { serialNumbers: string[] }).serialNumbers.sort()).toEqual([
      'card-1',
      'card-2',
    ]);
  });

  it('answers only about the passes that device holds', async () => {
    await register('card-1', 'device-1');
    await register('card-2', 'device-2');

    source.update('card-2', 'changed');

    const result = await passesUpdatedSince(options, {
      deviceLibraryIdentifier: 'device-1',
      passTypeIdentifier: PASS_TYPE,
      since: undefined,
    });

    expect((result.body as { serialNumbers: string[] }).serialNumbers).toEqual(['card-1']);
  });
});

describe('fetching the pass', () => {
  beforeEach(() => source.issue('card-1', 'seven stamps'));

  it('rebuilds it from what the product holds now', async () => {
    source.update('card-1', 'eight stamps');

    const result = await fetchPass(options, {
      passTypeIdentifier: PASS_TYPE,
      serialNumber: 'card-1',
      token: GOOD,
      ifModifiedSince: undefined,
    });

    expect(result.status).toBe(200);
    expect(result.bytes?.toString()).toBe('eight stamps');
    expect(result.headers?.['content-type']).toBe('application/vnd.apple.pkpass');
    expect(result.headers?.['last-modified']).toBeTruthy();
  });

  it('is 401 for a guess and 404 for a pass that is not there', async () => {
    await expect(
      fetchPass(options, {
        passTypeIdentifier: PASS_TYPE,
        serialNumber: 'card-1',
        token: 'a-guess',
        ifModifiedSince: undefined,
      }),
    ).resolves.toMatchObject({ status: 401 });

    await expect(
      fetchPass(options, {
        passTypeIdentifier: PASS_TYPE,
        serialNumber: 'no-such-card',
        token: GOOD,
        ifModifiedSince: undefined,
      }),
    ).resolves.toMatchObject({ status: 404 });
  });

  it('is 304 when the device already has a newer copy than the pass', async () => {
    const result = await fetchPass(options, {
      passTypeIdentifier: PASS_TYPE,
      serialNumber: 'card-1',
      token: GOOD,
      ifModifiedSince: new Date('2026-06-05T00:00:00Z').toUTCString(),
    });

    expect(result.status).toBe(304);
    expect(result.bytes).toBeUndefined();
  });

  /**
   * The loose comparison, and why it is loose.
   *
   * HTTP dates carry one second. A pass updated twice inside a second would be
   * reported unchanged on the second fetch, and the phone would keep a copy
   * that quietly stops matching. So an *equal* timestamp serves the pass: at
   * worst one redundant fetch, never a missed update.
   */
  it('serves the pass again when the timestamps are the same second', async () => {
    const at = new Date('2026-06-02T09:00:00.400Z');
    source.update('card-1', 'eight stamps', at);

    const result = await fetchPass(options, {
      passTypeIdentifier: PASS_TYPE,
      serialNumber: 'card-1',
      token: GOOD,
      ifModifiedSince: new Date('2026-06-02T09:00:00.000Z').toUTCString(),
    });

    expect(result.status).toBe(200);
    expect(result.bytes?.toString()).toBe('eight stamps');
  });

  it('ignores an If-Modified-Since it cannot read', async () => {
    const result = await fetchPass(options, {
      passTypeIdentifier: PASS_TYPE,
      serialNumber: 'card-1',
      token: GOOD,
      ifModifiedSince: 'yesterday afternoon',
    });

    expect(result.status).toBe(200);
  });

  /**
   * A voided pass still answers.
   *
   * Refusing would leave the holder's wallet showing the last good copy for
   * ever — a redeemed ticket that still scans, a wound-down card that still
   * shows a balance.
   */
  it('serves a pass that has been voided', async () => {
    source.passes.get('card-1')!.voided = true;

    const result = await fetchPass(options, {
      passTypeIdentifier: PASS_TYPE,
      serialNumber: 'card-1',
      token: GOOD,
      ifModifiedSince: undefined,
    });

    expect(result.status).toBe(200);
  });
});

describe('what a device reports', () => {
  it('takes the messages and always accepts them', () => {
    const result = deviceLog({ logs: ['could not verify the signature', 'web service refused'] });

    expect(result.status).toBe(200);
    expect(result.messages).toHaveLength(2);
  });

  it('accepts a body that makes no sense, because a device that cannot report an error should not have to handle one', () => {
    expect(deviceLog(undefined)).toEqual({ status: 200, messages: [] });
    expect(deviceLog({ logs: 'not an array' })).toEqual({ status: 200, messages: [] });
  });

  it('keeps at most fifty, so one broken device cannot fill a table', () => {
    const logs = Array.from({ length: 500 }, (_, index) => `line ${index}`);

    expect(deviceLog({ logs }).messages).toHaveLength(50);
  });
});
