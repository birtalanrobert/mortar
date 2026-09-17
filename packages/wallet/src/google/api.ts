import { signJwt } from '../jwt';
import type { GoogleWalletPort, GoogleWriteResult } from './port';

/**
 * The real Google Wallet API, over `fetch`.
 *
 * Two things here are worth more than the rest of the file.
 *
 * **The access token is exchanged, not signed.** Unlike a save link — which is
 * a JWT the *holder's browser* hands to Google — a write needs an OAuth access
 * token, obtained by signing an assertion and swapping it at Google's token
 * endpoint. Signing the assertion and sending it as a bearer token directly
 * produces a 401 with a message that does not say why.
 *
 * **An upsert is a PUT that falls back to a POST.** Google has no upsert, and a
 * product that tracks which identifiers it has created for itself will
 * eventually be wrong about one — a failed create, a restored backup, a
 * programme set up by hand in their console. Asking and then deciding costs a
 * round trip on every write; trying the update first costs one only the first
 * time.
 */

export interface GoogleWalletApiOptions {
  serviceAccountEmail: string;
  /** The service account's private key, PEM. */
  privateKey: string;
  /** Injected so a test can hold the clock still. */
  now?: () => Date;
  /** Injected so a test can answer without a network. */
  fetch?: typeof fetch;
}

const BASE = 'https://walletobjects.googleapis.com/walletobjects/v1';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/wallet_object.issuer';

/** Google issues these for an hour. Refreshed at fifty minutes. */
const TOKEN_LIFETIME_MS = 50 * 60_000;

export class GoogleWalletApi implements GoogleWalletPort {
  private token: { value: string; obtainedAt: number } | null = null;

  constructor(private readonly options: GoogleWalletApiOptions) {}

  upsertClass(loyaltyClass: Record<string, unknown>): Promise<GoogleWriteResult> {
    return this.upsert('loyaltyClass', loyaltyClass);
  }

  upsertObject(loyaltyObject: Record<string, unknown>): Promise<GoogleWriteResult> {
    return this.upsert('loyaltyObject', loyaltyObject);
  }

  private async upsert(
    resource: 'loyaltyClass' | 'loyaltyObject',
    payload: Record<string, unknown>,
  ): Promise<GoogleWriteResult> {
    const id = String(payload.id ?? '');
    const call = this.options.fetch ?? fetch;
    const authorization = `Bearer ${await this.accessToken()}`;

    const update = await call(`${BASE}/${resource}/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (update.ok) return { id, status: update.status, created: false };

    /* Anything but "it is not there" is a refusal worth reporting as one. */
    if (update.status !== 404) {
      return { id, status: update.status, reason: await reasonOf(update), created: false };
    }

    const insert = await call(`${BASE}/${resource}`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    return insert.ok
      ? { id, status: insert.status, created: true }
      : { id, status: insert.status, reason: await reasonOf(insert), created: false };
  }

  private async accessToken(): Promise<string> {
    const now = (this.options.now ?? (() => new Date()))();

    if (this.token && now.getTime() - this.token.obtainedAt < TOKEN_LIFETIME_MS) {
      return this.token.value;
    }

    const issuedAt = Math.floor(now.getTime() / 1000);

    const assertion = signJwt(
      {
        iss: this.options.serviceAccountEmail,
        scope: SCOPE,
        aud: TOKEN_ENDPOINT,
        iat: issuedAt,
        exp: issuedAt + 3600,
      },
      this.options.privateKey,
      { algorithm: 'RS256' },
    );

    const call = this.options.fetch ?? fetch;

    const response = await call(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    });

    if (!response.ok) {
      /* The body is Google's own explanation and contains no secret of ours —
         the assertion went the other way. Worth keeping in the message. */
      throw new Error(
        `Google refused the service account assertion (${response.status}): ${await reasonOf(response)}`,
      );
    }

    const body = (await response.json()) as { access_token?: string };
    if (!body.access_token) throw new Error('Google returned no access token.');

    this.token = { value: body.access_token, obtainedAt: now.getTime() };
    return body.access_token;
  }
}

async function reasonOf(response: Response): Promise<string> {
  try {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } | string };
      if (typeof parsed.error === 'string') return parsed.error;
      return parsed.error?.message ?? text.slice(0, 300);
    } catch {
      return text.slice(0, 300);
    }
  } catch {
    return `HTTP ${response.status}`;
  }
}
