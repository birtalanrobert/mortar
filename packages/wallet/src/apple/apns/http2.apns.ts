import { connect, constants, type ClientHttp2Session } from 'node:http2';
import { signJwt } from '../../jwt';
import type { ApnsPort, ApnsPush, ApnsResult } from './port';

/**
 * The real thing: HTTP/2 to Apple, with a token-based authentication header.
 *
 * Three details carry most of the ways this goes wrong.
 *
 * **The topic is the pass type identifier**, not an application's bundle id.
 * Getting it wrong produces `TopicDisallowed` on every push and no other
 * symptom.
 *
 * **The payload is empty.** A pass update carries `{}`; anything else is
 * ignored at best.
 *
 * **The authentication token is cached.** Apple refuses a provider token
 * regenerated more often than once every twenty minutes — `TooManyProviderTokenUpdates`
 * — and expires one older than an hour. Minting per request fails both ways at
 * once, which is why this holds one and refreshes it well inside the window.
 */

export interface Http2ApnsOptions {
  /** The `.p8` signing key from the Apple Developer account, as PEM. */
  privateKey: string;
  /** The key's ten-character identifier. */
  keyId: string;
  /** The ten-character team identifier. */
  teamId: string;
  /** `production` talks to api.push.apple.com; `sandbox` to the other one. */
  environment?: 'production' | 'sandbox';
  /** Injected so a test can hold the clock still. */
  now?: () => Date;
}

const HOSTS = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
} as const;

/**
 * Apple refuses a token older than an hour; this refreshes at forty minutes.
 *
 * Comfortably inside the expiry and comfortably outside the twenty-minute floor
 * on how often a new one may be minted.
 */
const TOKEN_LIFETIME_MS = 40 * 60_000;

/**
 * `apns-push-type` for a pass update.
 *
 * **Reviewed with `rules.ts`, and the least certain value in this package.**
 * Apple's push-type table has no entry for Wallet, and a pass update behaves as
 * a background push: an empty payload, no user-visible content, the device
 * waking to fetch. `background` is what that describes. The header became
 * required on watchOS 6 and recommended everywhere else, so omitting it is not
 * an option either.
 *
 * If a live run ever answers `BadPushType`, this constant is the one line that
 * changes — which is the reason it is a constant.
 */
const PUSH_TYPE = 'background';

export class Http2Apns implements ApnsPort {
  private session: ClientHttp2Session | null = null;
  private token: { value: string; mintedAt: number } | null = null;

  constructor(private readonly options: Http2ApnsOptions) {}

  async send(pushes: readonly ApnsPush[]): Promise<ApnsResult[]> {
    if (pushes.length === 0) return [];

    const session = this.connect();
    const authorization = `bearer ${this.authenticationToken()}`;

    /*
     * Concurrently over one connection, which is the whole reason APNs is
     * HTTP/2: a campaign to four thousand cards is four thousand streams over a
     * handful of sockets rather than four thousand handshakes.
     */
    return Promise.all(pushes.map((push) => this.one(session, push, authorization)));
  }

  /** Closes the connection. A worker that has finished should not hold one open. */
  close(): void {
    this.session?.close();
    this.session = null;
  }

  private connect(): ClientHttp2Session {
    if (this.session && !this.session.closed && !this.session.destroyed) return this.session;

    const session = connect(HOSTS[this.options.environment ?? 'production']);

    /*
     * Dropped rather than thrown. A connection error arrives asynchronously and
     * belongs to no particular push; letting it reach the process as an
     * unhandled `error` event takes the worker down for something the next
     * request would reconnect through.
     */
    session.on('error', () => {
      this.session = null;
    });
    session.on('close', () => {
      this.session = null;
    });

    this.session = session;
    return session;
  }

  private authenticationToken(): string {
    const now = (this.options.now ?? (() => new Date()))();

    if (this.token && now.getTime() - this.token.mintedAt < TOKEN_LIFETIME_MS) {
      return this.token.value;
    }

    const value = signJwt(
      { iss: this.options.teamId, iat: Math.floor(now.getTime() / 1000) },
      this.options.privateKey,
      { algorithm: 'ES256', keyId: this.options.keyId },
    );

    this.token = { value, mintedAt: now.getTime() };
    return value;
  }

  private one(
    session: ClientHttp2Session,
    push: ApnsPush,
    authorization: string,
  ): Promise<ApnsResult> {
    return new Promise((resolve) => {
      const request = session.request({
        [constants.HTTP2_HEADER_METHOD]: 'POST',
        [constants.HTTP2_HEADER_PATH]: `/3/device/${push.pushToken}`,
        [constants.HTTP2_HEADER_AUTHORIZATION]: authorization,
        'apns-topic': push.topic,
        'apns-push-type': PUSH_TYPE,
        /*
         * Lowest priority, which for a background push is the only one APNs
         * accepts — and is right anyway: a stamp appearing a minute later costs
         * nobody anything, and a phone that batches these uses less battery.
         */
        'apns-priority': '5',
        ...(push.collapseId ? { 'apns-collapse-id': push.collapseId } : {}),
      });

      let status = 0;
      let apnsId: string | undefined;
      let body = '';

      request.on('response', (headers) => {
        status = Number(headers[constants.HTTP2_HEADER_STATUS] ?? 0);
        apnsId = typeof headers['apns-id'] === 'string' ? headers['apns-id'] : undefined;
      });

      request.setEncoding('utf8');
      request.on('data', (chunk: string) => (body += chunk));

      request.on('error', (error: Error) => {
        /* A transport failure is reported like a refusal rather than thrown: the
           caller is sending thousands of these and wants a result per token. */
        resolve({ pushToken: push.pushToken, status: 0, reason: error.message });
      });

      request.on('end', () => {
        resolve({
          pushToken: push.pushToken,
          status,
          ...(apnsId ? { apnsId } : {}),
          ...(reasonOf(body) ? { reason: reasonOf(body)! } : {}),
        });
      });

      /* The empty payload. Everything the holder sees comes from the pass. */
      request.end('{}');
    });
  }
}

/** APNs answers a failure with `{"reason":"Unregistered"}` and little else. */
function reasonOf(body: string): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { reason?: string };
    return parsed.reason;
  } catch {
    return body.slice(0, 200);
  }
}
