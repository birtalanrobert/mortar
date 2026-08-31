import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Resend } from 'resend';
import { ResendInbound } from './resend';

const RECEIVED = { type: 'email.received', data: { email_id: 'em_1' } };

function client(parts: { verify?: () => unknown; get?: () => Promise<unknown> }): {
  resend: Resend;
  verify: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
} {
  const verify = vi.fn(parts.verify ?? (() => RECEIVED));
  const get = vi.fn(
    parts.get ??
      (async () => ({
        data: { raw: { download_url: 'https://files.resend.test/em_1' } },
        error: null,
      })),
  );

  return {
    verify,
    get,
    resend: {
      webhooks: { verify },
      emails: { receiving: { get } },
    } as unknown as Resend,
  };
}

const HEADERS = {
  'svix-id': 'msg_1',
  'svix-timestamp': '1756640000',
  'svix-signature': 'v1,abc',
};

describe('ResendInbound.verify', () => {
  it('returns the event when the vendor says the signature is good', () => {
    const { resend, verify } = client({});

    const event = new ResendInbound({
      apiKey: 're_test',
      webhookSecret: 'whsec_x',
      client: resend,
    }).verify('{"type":"email.received"}', HEADERS);

    expect(event).toEqual(RECEIVED);
    expect(verify).toHaveBeenCalledWith({
      payload: '{"type":"email.received"}',
      headers: { id: 'msg_1', timestamp: '1756640000', signature: 'v1,abc' },
      webhookSecret: 'whsec_x',
    });
  });

  it('returns nothing when the signature does not check out', () => {
    const { resend } = client({
      verify: () => {
        throw new Error('No matching signature found');
      },
    });

    /*
     * Undefined rather than a thrown error, on purpose.
     *
     * The caller's correct response is one unauthenticated answer for every
     * failure, and an exception carrying the reason tempts a route into
     * reporting which check failed — which tells whoever is probing what to fix.
     */
    expect(
      new ResendInbound({ apiKey: 're_test', webhookSecret: 'whsec_x', client: resend }).verify(
        '{}',
        HEADERS,
      ),
    ).toBeUndefined();
  });

  it('returns nothing when a header is missing', () => {
    const { resend, verify } = client({});

    expect(
      new ResendInbound({ apiKey: 're_test', webhookSecret: 'whsec_x', client: resend }).verify(
        '{}',
        { 'svix-id': 'msg_1' },
      ),
    ).toBeUndefined();
    expect(verify).not.toHaveBeenCalled();
  });

  it('reads headers whatever the framework made of them', () => {
    const { resend, verify } = client({});

    new ResendInbound({ apiKey: 're_test', webhookSecret: 'whsec_x', client: resend }).verify(
      '{}',
      {
        ...HEADERS,
        // Express hands an array back when a header arrives more than once.
        'svix-signature': ['v1,abc', 'v1,def'],
      },
    );

    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({ headers: expect.objectContaining({ signature: 'v1,abc' }) }),
    );
  });

  it('verifies nothing when no secret is configured', () => {
    const { resend, verify } = client({});

    // A deployment with no signing secret authenticates its inbound endpoint
    // another way — a shared header, a private network — and must not be told
    // by this class that an unsigned request was fine.
    expect(
      new ResendInbound({ apiKey: 're_test', client: resend }).verify('{}', HEADERS),
    ).toBeUndefined();
    expect(verify).not.toHaveBeenCalled();
  });

  it('takes the payload as the bytes that arrived', () => {
    const { resend, verify } = client({});

    new ResendInbound({ apiKey: 're_test', webhookSecret: 'whsec_x', client: resend }).verify(
      Buffer.from('{"a":1}'),
      HEADERS,
    );

    // The raw body, not a re-serialised object: JSON round-tripping reorders
    // keys and changes whitespace, and the signature is over bytes.
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ payload: '{"a":1}' }));
  });
});

describe('ResendInbound.emailIdOf', () => {
  it('names the email a received event is about', () => {
    expect(ResendInbound.emailIdOf(RECEIVED)).toBe('em_1');
  });

  it('ignores an event that is not a received email', () => {
    // The same endpoint may be sent delivery receipts and bounces. Treating one
    // as an inbound document would route a bounce into a client's checklist.
    expect(ResendInbound.emailIdOf({ type: 'email.delivered', data: { email_id: 'em_1' } })).toBe(
      undefined,
    );
  });
});

describe('ResendInbound.rawMime', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const inbound = (resend: Resend) => new ResendInbound({ apiKey: 're_test', client: resend });

  it('fetches the record, then the original it points at', async () => {
    const { resend, get } = client({});
    const fetch = vi.fn(async () => new Response('From: ion@example.ro\r\n\r\nHere it is.'));
    vi.stubGlobal('fetch', fetch);

    const mime = await inbound(resend).rawMime('em_1');

    expect(mime).toContain('From: ion@example.ro');
    expect(get).toHaveBeenCalledWith('em_1');
    // The signed URL carries its own authorisation; sending the API key to a
    // file host would be a second place it can leak from.
    expect(fetch).toHaveBeenCalledWith('https://files.resend.test/em_1');
  });

  it('says which message it could not read', async () => {
    const { resend } = client({
      get: async () => ({ data: null, error: { message: 'Not found' } }),
    });

    await expect(inbound(resend).rawMime('em_2')).rejects.toThrow(/em_2.*Not found/);
  });

  it('refuses a record with no original attached to it', async () => {
    const { resend } = client({ get: async () => ({ data: { html: '<p>hi</p>' }, error: null }) });

    // Parsing the provider's own fields instead would work and would tie every
    // consumer to this vendor's shape. The original is what keeps the parser
    // ours.
    await expect(inbound(resend).rawMime('em_3')).rejects.toThrow(/no original/);
  });

  it('says when the original itself cannot be downloaded', async () => {
    const { resend } = client({});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 403 })),
    );

    // A signed URL that has expired, which is a different problem from a
    // message the provider never had.
    await expect(inbound(resend).rawMime('em_4')).rejects.toThrow(/could not be read \(403\)/);
  });
});
