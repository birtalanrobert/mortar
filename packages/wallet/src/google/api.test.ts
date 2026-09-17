import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { verifyJwt } from '../jwt';
import { GoogleWalletApi } from './api';
import { RecordingGoogleWallet } from './port';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const NOW = new Date('2026-06-01T09:00:00Z');

interface Call {
  url: string;
  method: string;
  body: string;
}

/**
 * Google, answered by a function.
 *
 * `answer` decides the status per (method, url) so the PUT-then-POST fallback
 * can be exercised without a Google Cloud project — which is the whole reason
 * `fetch` is injectable here.
 */
function stubbed(answer: (call: Call) => { status: number; body?: unknown }) {
  const calls: Call[] = [];

  const call = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const record: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: String(init?.body ?? ''),
    };
    calls.push(record);

    const { status, body } = answer(record);

    return new Response(JSON.stringify(body ?? {}), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });

  return { calls, fetch: call as unknown as typeof fetch };
}

const api = (fetchImpl: typeof fetch) =>
  new GoogleWalletApi({
    serviceAccountEmail: 'passes@stamped.iam.gserviceaccount.com',
    privateKey: PEM,
    now: () => NOW,
    fetch: fetchImpl,
  });

const token = () => ({ status: 200, body: { access_token: 'an-access-token' } });

describe('writing to Google', () => {
  /**
   * The mistake that produces a 401 with a message that does not say why.
   *
   * A save link is a JWT the *holder's browser* hands to Google. A write needs
   * an OAuth access token, obtained by signing an assertion and exchanging it —
   * sending the assertion as a bearer token instead looks almost right and is
   * refused every time.
   */
  it('exchanges a signed assertion for an access token rather than sending the assertion', async () => {
    const { calls, fetch: stub } = stubbed((call) =>
      call.url.includes('oauth2') ? token() : { status: 200 },
    );

    await api(stub).upsertObject({ id: '3388.card-1' });

    const exchange = calls[0]!;
    expect(exchange.url).toBe('https://oauth2.googleapis.com/token');
    expect(exchange.body).toContain(
      'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer',
    );

    const assertion = new URLSearchParams(exchange.body).get('assertion')!;
    const verified = verifyJwt(assertion, publicKey, 'RS256');

    expect(verified?.claims).toMatchObject({
      iss: 'passes@stamped.iam.gserviceaccount.com',
      aud: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/wallet_object.issuer',
    });

    /* And the write carries the token Google gave back, not the assertion. */
    expect(calls[1]?.url).toContain('walletobjects');
  });

  it('reuses the access token rather than exchanging one per write', async () => {
    const { calls, fetch: stub } = stubbed((call) =>
      call.url.includes('oauth2') ? token() : { status: 200 },
    );

    const client = api(stub);
    await client.upsertObject({ id: '3388.card-1' });
    await client.upsertObject({ id: '3388.card-2' });

    // Google issues these for an hour. One per write would be three thousand
    // exchanges during a campaign, and Google rate-limits them.
    expect(calls.filter((one) => one.url.includes('oauth2'))).toHaveLength(1);
  });

  it('updates first, and creates only when there is nothing to update', async () => {
    const { calls, fetch: stub } = stubbed((call) => {
      if (call.url.includes('oauth2')) return token();
      return call.method === 'PUT' ? { status: 404 } : { status: 200 };
    });

    const result = await api(stub).upsertObject({ id: '3388.card-1' });

    /*
     * Google has no upsert. Tracking which identifiers we have created is a
     * record that will eventually be wrong — a failed create, a restored
     * backup, a programme somebody set up by hand in their console — so the
     * update is tried first and costs a round trip only the first time.
     */
    expect(calls.map((one) => one.method)).toEqual(['POST', 'PUT', 'POST']);
    expect(result).toMatchObject({ created: true, status: 200 });
  });

  it('does not create when the update worked', async () => {
    const { calls, fetch: stub } = stubbed((call) =>
      call.url.includes('oauth2') ? token() : { status: 200 },
    );

    const result = await api(stub).upsertObject({ id: '3388.card-1' });

    expect(calls.filter((one) => one.url.includes('walletobjects'))).toHaveLength(1);
    expect(result).toMatchObject({ created: false });
  });

  it('reports a refusal rather than treating it as absence', async () => {
    const { fetch: stub } = stubbed((call) => {
      if (call.url.includes('oauth2')) return token();
      return { status: 403, body: { error: { message: 'Issuer not authorised' } } };
    });

    /* A 403 is not "it is not there": retrying it as a create would make a
       second row on the day the permission comes back. */
    const result = await api(stub).upsertObject({ id: '3388.card-1' });

    expect(result).toMatchObject({ status: 403, created: false, reason: 'Issuer not authorised' });
  });

  it('says so plainly when Google will not accept the service account', async () => {
    const { fetch: stub } = stubbed(() => ({
      status: 400,
      body: { error: 'invalid_grant', error_description: 'Invalid JWT' },
    }));

    await expect(api(stub).upsertClass({ id: '3388.cafea' })).rejects.toThrow(/invalid_grant/);
  });

  it('writes a class to the class endpoint and an object to the object one', async () => {
    const { calls, fetch: stub } = stubbed((call) =>
      call.url.includes('oauth2') ? token() : { status: 200 },
    );

    const client = api(stub);
    await client.upsertClass({ id: '3388.cafea' });
    await client.upsertObject({ id: '3388.card-1' });

    expect(calls[1]?.url).toContain('/loyaltyClass/');
    expect(calls[2]?.url).toContain('/loyaltyObject/');
  });
});

describe('the recording client', () => {
  it('remembers what was written and answers created once', async () => {
    const google = new RecordingGoogleWallet();

    const first = await google.upsertObject({ id: '3388.card-1', state: 'ACTIVE' });
    const second = await google.upsertObject({ id: '3388.card-1', state: 'INACTIVE' });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(google.objects).toHaveLength(2);
    expect(google.latestObject('3388.card-1')).toMatchObject({ state: 'INACTIVE' });
  });

  it('can refuse, so a product’s error path is reachable without a network', async () => {
    const google = new RecordingGoogleWallet();
    google.refuse('3388.card-1', 403, 'Issuer not authorised');

    await expect(google.upsertObject({ id: '3388.card-1' })).resolves.toMatchObject({
      status: 403,
      reason: 'Issuer not authorised',
    });
  });
});
