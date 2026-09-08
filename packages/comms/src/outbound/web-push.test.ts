import { afterEach, describe, expect, it, vi } from 'vitest';
import webPushModule from 'web-push';
import { PushSubscriptionGone, WebPushMessagePort } from './web-push';

/**
 * Writing to a browser that has agreed to it.
 *
 * The library is mocked because what is worth asserting is *our* behaviour
 * around it — which endpoint, which payload, and above all what happens when a
 * push service says the subscription is gone. Asserting that `web-push`
 * encrypts correctly would be testing somebody else's code, and badly.
 */
vi.mock('web-push', () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(),
  },
}));

/*
 * Imported statically, because this file is CommonJS and a top-level `await`
 * is not available to it. `vi.mock` is hoisted above the imports either way,
 * so the mocked module is what arrives here.
 */
const webpush = webPushModule as unknown as {
  sendNotification: ReturnType<typeof vi.fn>;
  setVapidDetails: ReturnType<typeof vi.fn>;
};

const VAPID = {
  subject: 'mailto:hello@example.com',
  publicKey: 'a-public-key',
  privateKey: 'a-private-key',
};

const KEYS = { p256dh: 'a-p256dh-key', auth: 'an-auth-secret' };

/**
 * A `DataSource` reduced to the one lookup this port makes.
 *
 * The port reads `mortar_push_subscription` — this package's own table — so
 * what a fake needs to answer is one `findOne`. Standing up a real database to
 * assert which endpoint was encrypted to would be testing TypeORM.
 */
const dataSourceReturning = (row: typeof KEYS | null) =>
  ({
    getRepository: () => ({ findOne: async () => row }),
  }) as never;

describe('sending a web push', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  const port = (overrides: Record<string, unknown> = {}) =>
    new WebPushMessagePort({
      vapid: VAPID,
      dataSource: dataSourceReturning(KEYS),
      ...overrides,
    });

  it('encrypts to the endpoint the message names', async () => {
    webpush.sendNotification.mockResolvedValue({ statusCode: 201 });

    await port().send({
      channel: 'push',
      to: 'https://push.example.com/abc',
      subject: 'Your rota is out',
      text: 'You are on Monday 09:00–17:00.',
    });

    const [subscription, payload] = webpush.sendNotification.mock.calls[0]!;

    expect(subscription).toEqual({ endpoint: 'https://push.example.com/abc', keys: KEYS });

    // A title and a sentence, which is what a lock screen shows. Anything
    // longer belongs in the application the tap opens.
    expect(JSON.parse(payload as string)).toMatchObject({
      title: 'Your rota is out',
      body: 'You are on Monday 09:00–17:00.',
    });
  });

  it('carries where a tap should land', async () => {
    webpush.sendNotification.mockResolvedValue({ statusCode: 201 });

    await port().send({
      channel: 'push',
      to: 'https://push.example.com/abc',
      text: 'Your rota has changed.',
      url: '/shifts',
    });

    /*
     * In the payload rather than a header: it is the service worker that
     * decides what a notification does, and it reads this. One that opens
     * nothing in particular is one people stop tapping.
     */
    expect(JSON.parse(webpush.sendNotification.mock.calls[0]![1] as string).url).toBe('/shifts');
  });

  it('says the subscription is gone on a 410, and asks for it to be forgotten', async () => {
    webpush.sendNotification.mockRejectedValue({ statusCode: 410 });

    const forgotten: string[] = [];
    const sending = port({ onGone: (endpoint: string) => void forgotten.push(endpoint) }).send({
      channel: 'push',
      to: 'https://push.example.com/gone',
      text: 'Anything.',
    });

    /*
     * **410 means delete, and nothing else does.** A browser that has revoked
     * permission answers this for ever, and a product that keeps trying has
     * delivery figures that are quietly meaningless — which is the whole reason
     * this lives in mortar rather than in three products.
     */
    await expect(sending).rejects.toBeInstanceOf(PushSubscriptionGone);
    expect(forgotten).toEqual(['https://push.example.com/gone']);
  });

  it('treats a 404 the same way', async () => {
    webpush.sendNotification.mockRejectedValue({ statusCode: 404 });

    await expect(
      port().send({ channel: 'push', to: 'https://push.example.com/x', text: 'Anything.' }),
    ).rejects.toBeInstanceOf(PushSubscriptionGone);
  });

  it('does not delete a subscription over a bad afternoon', async () => {
    webpush.sendNotification.mockRejectedValue({ statusCode: 503 });

    const forgotten: string[] = [];
    const sending = port({ onGone: (endpoint: string) => void forgotten.push(endpoint) }).send({
      channel: 'push',
      to: 'https://push.example.com/fine',
      text: 'Anything.',
    });

    /*
     * A push service having a bad minute is not a person revoking permission,
     * and forgetting them over it means they stop hearing from the product
     * with nothing anywhere saying why.
     */
    await expect(sending).rejects.not.toBeInstanceOf(PushSubscriptionGone);
    expect(forgotten).toEqual([]);
  });

  it('refuses an endpoint it has no keys for, rather than sending nothing', async () => {
    // A row that has been deleted, or an address somebody typed. The same
    // answer as the push service's own, so there is one behaviour to reason
    // about rather than two.
    await expect(
      port({ dataSource: dataSourceReturning(null) }).send({
        channel: 'push',
        to: 'https://push.example.com/unknown',
        text: 'Anything.',
      }),
    ).rejects.toBeInstanceOf(PushSubscriptionGone);
  });
});
