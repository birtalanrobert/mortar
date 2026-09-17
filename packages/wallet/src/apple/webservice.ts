/**
 * Apple's update web service: the four endpoints a device calls, plus the log.
 *
 * Written framework-free and tested against a client that plays the device's
 * part, because this is the protocol that decides whether updates are reliable
 * or intermittent — and because there is no phone in this programme to find out
 * from.
 *
 * The device's side of the conversation, in order:
 *
 * 1. A pass is installed. The device **registers**, handing over a push token.
 * 2. Something changes. We send an empty push to that token.
 * 3. The device asks **which of its passes changed since a tag** we gave it.
 * 4. It **fetches** each one and replaces what it holds.
 * 5. The pass is removed from the wallet. The device **deregisters**.
 *
 * `POST /v1/log` is a fifth endpoint and is not optional here. It is the only
 * channel Apple gives for hearing why a device refused something, and a
 * programme with no device of its own has more use for it than most.
 */

/** Where the product keeps its passes. The only thing this protocol cannot own. */
export interface PassRecord {
  passTypeIdentifier: string;
  serialNumber: string;
  /**
   * Which generation of the authentication token this pass was issued with.
   *
   * See `token.ts`: the token is derived rather than stored, and this number is
   * what rotating it means.
   */
  tokenVersion: number;
  /** When its content last changed. Answers `Last-Modified`. */
  updatedAt: Date;
  /**
   * A pass that has been voided still answers, and still says it is void.
   *
   * Refusing to serve it would leave the holder's wallet showing the last good
   * copy for ever — a redeemed ticket that still scans, a wound-down card that
   * still shows a balance.
   */
  voided: boolean;
}

export interface UpdatedSince {
  serialNumbers: string[];
  /** The tag to hand back, which the device sends next time. */
  lastUpdated: string;
}

/**
 * What the product supplies. Three methods, and none of them knows about HTTP.
 *
 * Registrations are **not** here: they are the same table whatever the pass
 * means, so this package owns them. What differs per product is what a pass
 * *is*, which is exactly these three questions.
 */
export interface PassSource {
  find(passTypeIdentifier: string, serialNumber: string): Promise<PassRecord | null>;

  /** The signed `.pkpass`, rebuilt from whatever the product holds now. */
  build(pass: PassRecord): Promise<Buffer>;

  /**
   * Which of these serials changed after `since`, and the new tag.
   *
   * The serials are the ones this device is registered for; narrowing them is
   * the product's job because only it knows what "changed" means.
   *
   * **The tag must not come from a clock.** Two updates inside the same tick
   * produce one tag, and the second is never fetched — the pass on the phone
   * silently stops matching the database. A monotonic sequence assigned per
   * update is the whole of the fix, and it is the single most consequential
   * decision in this file.
   */
  updatedSince(
    passTypeIdentifier: string,
    serialNumbers: readonly string[],
    since: string | undefined,
  ): Promise<UpdatedSince>;
}

/** Where this package keeps which device holds which pass. */
export interface RegistrationStore {
  /** `true` when this is a new registration, `false` when the device already had it. */
  add(input: {
    deviceLibraryIdentifier: string;
    pushToken: string;
    passTypeIdentifier: string;
    serialNumber: string;
    tenantId?: string;
  }): Promise<boolean>;

  /** `true` when something was removed. */
  remove(input: {
    deviceLibraryIdentifier: string;
    passTypeIdentifier: string;
    serialNumber: string;
  }): Promise<boolean>;

  /** Every serial this device holds of this pass type. */
  serialsFor(deviceLibraryIdentifier: string, passTypeIdentifier: string): Promise<string[]>;

  /** Every device holding this pass, for the push. */
  devicesFor(
    passTypeIdentifier: string,
    serialNumber: string,
  ): Promise<Array<{ deviceLibraryIdentifier: string; pushToken: string }>>;
}

/**
 * The outcome of one endpoint, as status and body rather than as a framework's
 * response object.
 *
 * Keeping HTTP out of the handlers is what lets the device-side test client
 * exercise them directly, and what would let a second product mount them on
 * something other than Nest.
 */
export interface ProtocolResult {
  status: number;
  body?: unknown;
  /** Only the pass fetch sets these. */
  bytes?: Buffer;
  headers?: Record<string, string>;
}

const UNAUTHORISED: ProtocolResult = { status: 401 };
const NOT_FOUND: ProtocolResult = { status: 404 };

export interface ProtocolOptions {
  source: PassSource;
  registrations: RegistrationStore;
  /** Checks the token the device presented. Supplied so the secret stays outside. */
  authorise: (pass: PassRecord, presentedToken: string | null) => boolean;
}

/**
 * `POST /v1/devices/{device}/registrations/{passType}/{serial}`
 *
 * 201 when the device did not have it, 200 when it did. Apple's own
 * documentation draws that distinction and devices rely on it: a 201 for a
 * registration that already existed makes a device that retries look like a
 * device that installed the pass twice.
 */
export async function registerDevice(
  options: ProtocolOptions,
  request: {
    deviceLibraryIdentifier: string;
    passTypeIdentifier: string;
    serialNumber: string;
    pushToken: string;
    token: string | null;
  },
): Promise<ProtocolResult> {
  const pass = await options.source.find(request.passTypeIdentifier, request.serialNumber);
  if (!pass) return NOT_FOUND;
  if (!options.authorise(pass, request.token)) return UNAUTHORISED;

  if (!request.pushToken) return { status: 400, body: { message: 'A push token is required.' } };

  const created = await options.registrations.add({
    deviceLibraryIdentifier: request.deviceLibraryIdentifier,
    pushToken: request.pushToken,
    passTypeIdentifier: request.passTypeIdentifier,
    serialNumber: request.serialNumber,
  });

  return { status: created ? 201 : 200 };
}

/**
 * `DELETE /v1/devices/{device}/registrations/{passType}/{serial}`
 *
 * The holder removed the pass from their wallet. **That is a withdrawal of
 * consent as well as a database row**, and the product is told so through the
 * store rather than being expected to notice — see the `onRemoved` hook the
 * Nest module wires up.
 */
export async function unregisterDevice(
  options: ProtocolOptions,
  request: {
    deviceLibraryIdentifier: string;
    passTypeIdentifier: string;
    serialNumber: string;
    token: string | null;
  },
): Promise<ProtocolResult> {
  const pass = await options.source.find(request.passTypeIdentifier, request.serialNumber);
  if (!pass) return NOT_FOUND;
  if (!options.authorise(pass, request.token)) return UNAUTHORISED;

  await options.registrations.remove({
    deviceLibraryIdentifier: request.deviceLibraryIdentifier,
    passTypeIdentifier: request.passTypeIdentifier,
    serialNumber: request.serialNumber,
  });

  /* 200 whether or not a row went. A device that retries a deregistration has
     not made a mistake, and telling it otherwise makes it retry harder. */
  return { status: 200 };
}

/**
 * `GET /v1/devices/{device}/registrations/{passType}?passesUpdatedSince={tag}`
 *
 * **Unauthenticated, and that is Apple's design rather than an oversight.** The
 * device identifier is the credential: it is opaque, per device, and known only
 * to the device and to us. Requiring a pass token here would be impossible —
 * the question is about several passes at once.
 *
 * 204 when nothing changed, which is the answer a device gets most of the time
 * and the one an implementation most often gets wrong by returning 200 with an
 * empty array. A device reading that as "these zero passes changed" will still
 * store the new tag, which is harmless; a device treating it as an error is not.
 */
export async function passesUpdatedSince(
  options: ProtocolOptions,
  request: {
    deviceLibraryIdentifier: string;
    passTypeIdentifier: string;
    since: string | undefined;
  },
): Promise<ProtocolResult> {
  const registered = await options.registrations.serialsFor(
    request.deviceLibraryIdentifier,
    request.passTypeIdentifier,
  );

  if (registered.length === 0) return NOT_FOUND;

  const updated = await options.source.updatedSince(
    request.passTypeIdentifier,
    registered,
    request.since,
  );

  if (updated.serialNumbers.length === 0) return { status: 204 };

  return {
    status: 200,
    body: { serialNumbers: updated.serialNumbers, lastUpdated: updated.lastUpdated },
  };
}

/**
 * `GET /v1/passes/{passType}/{serial}`
 *
 * Rebuilt on every fetch rather than served from storage, so what the device
 * receives is what the database says now.
 *
 * **The `If-Modified-Since` comparison is deliberately loose.** HTTP dates have
 * one-second resolution; a pass updated twice inside a second would otherwise
 * be reported as unchanged on the second fetch, and the phone would keep a copy
 * that quietly stops matching. So 304 is returned only when the pass is
 * *strictly older* than the date the device sent — at worst one redundant
 * fetch, never a missed update. That trade is the right way round: the cost of
 * a wasted request is a few kilobytes and the cost of a missed update is a
 * customer told they have seven stamps when they have eight.
 */
export async function fetchPass(
  options: ProtocolOptions,
  request: {
    passTypeIdentifier: string;
    serialNumber: string;
    token: string | null;
    ifModifiedSince: string | undefined;
  },
): Promise<ProtocolResult> {
  const pass = await options.source.find(request.passTypeIdentifier, request.serialNumber);
  if (!pass) return NOT_FOUND;
  if (!options.authorise(pass, request.token)) return UNAUTHORISED;

  const lastModified = toHttpDate(pass.updatedAt);

  if (request.ifModifiedSince) {
    const since = Date.parse(request.ifModifiedSince);
    if (Number.isFinite(since) && truncateToSecond(pass.updatedAt) < since) {
      return { status: 304, headers: { 'last-modified': lastModified } };
    }
  }

  return {
    status: 200,
    bytes: await options.source.build(pass),
    headers: {
      'content-type': 'application/vnd.apple.pkpass',
      'last-modified': lastModified,
      /* Wallet is the only client and it caches by `Last-Modified`; telling a
         proxy in between to keep a customer's pass would be worse than useless. */
      'cache-control': 'no-store',
    },
  };
}

/**
 * `POST /v1/log`
 *
 * Devices post their own errors here — a refused pass, a signature it would not
 * accept, a web service it could not reach. Apple sends no other diagnostic
 * anywhere, and a programme testing without a device has more use for this than
 * one that can simply look at a phone.
 *
 * Always 200. A device that cannot report an error should not then have to
 * handle an error reporting it.
 */
export function deviceLog(entries: unknown): { status: number; messages: string[] } {
  const raw = (entries as { logs?: unknown })?.logs;
  const messages = Array.isArray(raw) ? raw.map((one) => String(one)).slice(0, 50) : [];

  return { status: 200, messages };
}

/** RFC 9110's preferred date format, which is what `Last-Modified` must be. */
const toHttpDate = (when: Date): string => new Date(truncateToSecond(when)).toUTCString();

const truncateToSecond = (when: Date): number => Math.floor(when.getTime() / 1000) * 1000;
