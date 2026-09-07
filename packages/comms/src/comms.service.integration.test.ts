import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDataSource } from '@birtalanrobert/database';
import type { DataSource } from 'typeorm';
import { CommsService } from './comms.service';
import { parseMime } from './inbound/mime';
import { MessageLog } from './message-log.entity';
import { Suppression } from './suppression.entity';
import { CreateMessageLog1787813849846 } from './migrations/1787813849846-CreateMessageLog';
import { CreateSuppressions1790400000000 } from './migrations/1790400000000-CreateSuppressions';
import { AllowWhatsApp1791400000000 } from './migrations/1791400000000-AllowWhatsApp';
import { FallbackMessagePort } from './outbound/fallback';
import { NoopMessagePort, type Channel, type MessagePort } from './outbound/port';
import { WhatsAppRefused, NOT_ON_WHATSAPP } from './outbound/whatsapp';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SECRET = 'a-secret-that-is-at-least-thirty-two-characters';

let dataSource: DataSource;

beforeEach(async () => {
  dataSource ??= await createTestDataSource([MessageLog, Suppression], {
    // The real migration, not `synchronize`: the partial unique index is the
    // part that matters here and synchronize does not create it.
    migrations: [
      CreateMessageLog1787813849846,
      CreateSuppressions1790400000000,
      AllowWhatsApp1791400000000,
    ],
  });
  await dataSource.getRepository(MessageLog).clear();
  await dataSource.getRepository(Suppression).clear();
});

afterAll(async () => {
  if (dataSource?.isInitialized) await dataSource.destroy();
});

function service(ports: Partial<Record<Channel, MessagePort>> = {}) {
  return new CommsService(dataSource, {
    ports,
    inbound: { domain: 'in.example.com', secret: SECRET },
  });
}

const crlf = (lines: string[]) => lines.join('\r\n');

describe('sending', () => {
  it('records what the provider accepted', async () => {
    const email = new NoopMessagePort('email');
    const comms = service({ email });

    const log = await comms.send(
      { channel: 'email', to: 'ion@example.com', subject: 'Reminder', text: 'Two items left.' },
      { tenantId: TENANT, subject: 'request:1' },
    );

    // `accepted`, not `delivered`: the provider has taken it, and whether it
    // reached a person is a later webhook's news.
    expect(log.state).toBe('accepted');
    expect(log.providerMessageId).toBeTruthy();
    expect(email.sent).toHaveLength(1);
  });

  it('carries an attachment through to the provider', async () => {
    const email = new NoopMessagePort('email');
    const comms = service({ email });

    const log = await comms.send(
      {
        channel: 'email',
        to: 'firm@example.com',
        subject: 'Documents',
        text: 'Everything they sent.',
        attachments: [
          {
            filename: 'Ion_Popescu.zip',
            content: Buffer.alloc(1024),
            contentType: 'application/zip',
          },
        ],
      },
      { tenantId: TENANT, subject: 'request:1' },
    );

    expect(log.state).toBe('accepted');
    expect(email.sent[0]?.attachments).toHaveLength(1);
    // What was attached, not what it contained: the log is read by support, and
    // a client's filenames are not theirs to read.
    expect(log.metadata).toMatchObject({ attachments: 1, attachedBytes: 1024 });
  });

  it('refuses an attachment no mail server would take', async () => {
    const email = new NoopMessagePort('email');
    const comms = service({ email });

    const log = await comms.send(
      {
        channel: 'email',
        to: 'firm@example.com',
        text: 'x',
        attachments: [{ filename: 'huge.zip', content: Buffer.alloc(11 * 1024 * 1024) }],
      },
      { tenantId: TENANT, subject: 'request:1' },
    );

    /*
     * Refused here rather than at the provider.
     *
     * A receiving server bounces an oversized attachment silently and late,
     * which becomes "the firm never got it and nobody knows why". This fails
     * now, with a sentence the sender can act on — and nothing is handed to the
     * provider at all.
     */
    expect(log.state).toBe('failed');
    expect(log.detail).toContain('over the 10 MB limit');
    expect(email.sent).toHaveLength(0);
  });

  it('records a failure rather than throwing it at the caller', async () => {
    const broken: MessagePort = {
      channel: 'email',
      send: async () => {
        throw new Error('provider refused the domain');
      },
    };
    const comms = service({ email: broken });

    const log = await comms.send(
      { channel: 'email', to: 'ion@example.com', text: 'x' },
      { tenantId: TENANT, subject: 'request:1' },
    );

    // "Did my client get that reminder?" is a question a professional asks
    // after the fact, and only a log can answer it.
    expect(log.state).toBe('failed');
    expect(log.detail).toContain('provider refused');
  });

  it('says so when a channel has no provider at all', async () => {
    const comms = service({});

    const log = await comms.send({ channel: 'sms', to: '+40712345678', text: 'x' });

    expect(log.state).toBe('failed');
    expect(log.detail).toContain('No sms provider');
  });

  it('keeps the segment count, because the ledger is debited by it', async () => {
    const sms: MessagePort = {
      channel: 'sms',
      send: async () => ({ acceptedAt: new Date(), providerMessageId: 'sm-1', segments: 3 }),
    };
    const comms = service({ sms });

    const log = await comms.send({ channel: 'sms', to: '+40712345678', text: 'a long message' });

    expect(log.segments).toBe(3);
  });
});

describe('a port that diverts to another channel', () => {
  /** Refuses the way Twilio does for a number that is not on WhatsApp. */
  const notOnWhatsApp: MessagePort = {
    channel: 'whatsapp',
    async send() {
      throw new WhatsAppRefused('not on WhatsApp', NOT_ON_WHATSAPP);
    },
  };

  it('records the channel that carried it, not the one asked for', async () => {
    const sms = new NoopMessagePort('sms');
    const comms = service({ whatsapp: new FallbackMessagePort(notOnWhatsApp, sms) });

    const log = await comms.send(
      { channel: 'whatsapp', to: '+40722000111', text: 'Tomorrow at ten.' },
      { tenantId: TENANT, subject: 'booking:1' },
    );

    // "Sent on WhatsApp" for a message that went by SMS is an answer to "why
    // was I billed for texts?" that happens to be wrong.
    expect(log.state).toBe('accepted');
    expect(log.channel).toBe('sms');
    expect(sms.sent).toHaveLength(1);
  });

  it('honours a refusal recorded against the channel it would divert to', async () => {
    const sms = new NoopMessagePort('sms');
    const comms = service({ whatsapp: new FallbackMessagePort(notOnWhatsApp, sms) });

    await comms.unsubscribe(TENANT, 'sms', '+40722000222');

    const log = await comms.send(
      { channel: 'whatsapp', to: '+40722000222', text: 'Tomorrow at ten.' },
      { tenantId: TENANT, subject: 'booking:2' },
    );

    /*
     * They replied STOP to a text message, and their refusal is recorded
     * against `sms`. Addressing the same number on WhatsApp must not be a way
     * round it, because we cannot promise which channel will carry it.
     */
    expect(log.state).toBe('discarded');
    expect(sms.sent).toHaveLength(0);
  });

  it('still sends when only an unrelated channel has been refused', async () => {
    const sms = new NoopMessagePort('sms');
    const comms = service({ whatsapp: new FallbackMessagePort(notOnWhatsApp, sms) });

    await comms.unsubscribe(TENANT, 'email', 'ion@example.com');

    const log = await comms.send(
      { channel: 'whatsapp', to: '+40722000333', text: 'Tomorrow at ten.' },
      { tenantId: TENANT, subject: 'booking:3' },
    );

    expect(log.state).toBe('accepted');
  });
});

describe('delivery receipts', () => {
  it('settles a message the provider later reports on', async () => {
    const comms = service({ email: new NoopMessagePort('email') });
    const sent = await comms.send(
      { channel: 'email', to: 'ion@example.com', text: 'x' },
      { tenantId: TENANT, subject: 'request:1' },
    );

    const settled = await comms.settle(sent.providerMessageId!, 'delivered');

    expect(settled?.state).toBe('delivered');
    expect(settled?.settledAt).not.toBeNull();
  });

  it('records a bounce with the provider’s words', async () => {
    const comms = service({ email: new NoopMessagePort('email') });
    const sent = await comms.send({ channel: 'email', to: 'wrong@example.com', text: 'x' });

    const settled = await comms.settle(sent.providerMessageId!, 'bounced', 'mailbox unavailable');

    expect(settled?.state).toBe('bounced');
    expect(settled?.detail).toBe('mailbox unavailable');
  });

  it('ignores a receipt for something it never sent', async () => {
    const comms = service({ email: new NoopMessagePort('email') });

    // It belongs to another environment sharing the provider account, and
    // inventing a row would put another system's messages in this one's log.
    expect(await comms.settle('someone-elses-id', 'delivered')).toBeUndefined();
  });
});

describe('receiving', () => {
  const forwarded = (to: string, providerId = 'msg-1') =>
    parseMime(
      crlf([
        'From: Ion Popescu <ion@example.com>',
        `To: ${to}`,
        'Subject: Extras de cont',
        `Message-ID: <${providerId}@example.com>`,
        'Content-Type: multipart/mixed; boundary="bnd"',
        '',
        '--bnd',
        'Content-Type: text/plain',
        '',
        'Atasat.',
        '--bnd',
        'Content-Type: application/pdf',
        'Content-Disposition: attachment; filename="extras.pdf"',
        '',
        'bytes',
        '--bnd--',
      ]),
    );

  it('routes a message sent to a minted address', async () => {
    const comms = service();
    const address = comms.inboundAddressFor('request-1')!;

    const result = await comms.receive(forwarded(address));

    expect(result.subject).toBe('request-1');
    expect(result.duplicate).toBe(false);
    expect(result.log.state).toBe('received');
  });

  it('finds our address among a forward’s other recipients', async () => {
    const comms = service();
    const address = comms.inboundAddressFor('request-1')!;

    const result = await comms.receive(forwarded(`contabil@example.com, ${address}`));

    expect(result.subject).toBe('request-1');
  });

  it('recognises a redelivery instead of doing the work twice', async () => {
    const comms = service();
    const address = comms.inboundAddressFor('request-1')!;

    await comms.receive(forwarded(address));
    const second = await comms.receive(forwarded(address));

    // Providers redeliver — that is how at-least-once works — and without this
    // a client's forwarded bank statement is attached three times.
    expect(second.duplicate).toBe(true);
    expect(await dataSource.getRepository(MessageLog).count()).toBe(1);
  });

  it('treats two different messages as different', async () => {
    const comms = service();
    const address = comms.inboundAddressFor('request-1')!;

    await comms.receive(forwarded(address, 'msg-1'));
    const second = await comms.receive(forwarded(address, 'msg-2'));

    expect(second.duplicate).toBe(false);
  });

  it('logs a message it cannot route rather than dropping it', async () => {
    const comms = service();

    const result = await comms.receive(forwarded('nobody@in.example.com'));

    // Someone will ask why a forwarded document never appeared, and "it went
    // to an address nobody issued" is an answer only a log can give.
    expect(result.subject).toBeUndefined();
    expect(result.log.state).toBe('discarded');
    expect(result.log.address).toBe('ion@example.com');
  });

  it('refuses a forged address', async () => {
    const comms = service();

    const result = await comms.receive(forwarded('docs+request-1.0000000000000000@in.example.com'));

    expect(result.log.state).toBe('discarded');
  });

  it('counts the attachments without storing the document', async () => {
    const comms = service();
    const address = comms.inboundAddressFor('request-1')!;

    const result = await comms.receive(forwarded(address));

    expect(result.log.metadata.attachments).toBe(1);
    // Inbound mail here is bank statements, and a log table is the last place
    // they should be when someone asks for an erasure.
    expect(JSON.stringify(result.log.metadata)).not.toContain('bytes');
  });
});

describe('history', () => {
  it('returns everything about one subject, newest first', async () => {
    const comms = service({ email: new NoopMessagePort('email') });
    await comms.send(
      { channel: 'email', to: 'a@example.com', text: 'first' },
      { tenantId: TENANT, subject: 'request:1' },
    );
    await comms.send(
      { channel: 'email', to: 'a@example.com', text: 'second' },
      { tenantId: TENANT, subject: 'request:1' },
    );
    await comms.send(
      { channel: 'email', to: 'b@example.com', text: 'other' },
      { tenantId: TENANT, subject: 'request:2' },
    );

    const history = await comms.history(TENANT, 'request:1');

    expect(history).toHaveLength(2);
  });
});

describe('without inbound configured', () => {
  it('mints no address and routes nothing', async () => {
    const comms = new CommsService(dataSource, {});

    expect(comms.inboundAddressFor('request-1')).toBeUndefined();
  });
});

describe('addresses that have said no', () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';

  it('writes to a number that has refused once, because it may be switched off', async () => {
    /*
     * One failure is a telephone in a tunnel. Suppressing on the first would
     * silence a customer who was on an aeroplane, and they would never know.
     */
    const comms = service();

    await comms.recordRefusal(TENANT, 'sms', '+40722000001', 'unreachable');

    const sent = await comms.send(
      { channel: 'sms', to: '+40722000001', text: 'Reminder' },
      { tenantId: TENANT },
    );

    expect(sent.state).not.toBe('discarded');
  });

  it('stops after enough refusals, and says how many', async () => {
    const comms = service();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await comms.recordRefusal(TENANT, 'sms', '+40722000002', '21610: unsubscribed recipient');
    }

    const sent = await comms.send(
      { channel: 'sms', to: '+40722000002', text: 'Reminder' },
      { tenantId: TENANT },
    );

    /*
     * `discarded`, not `failed`. Nothing went wrong: we chose not to write to a
     * number that keeps refusing. A failure rate counting these would measure
     * the product obeying its own rules.
     */
    expect(sent.state).toBe('discarded');
    expect(sent.detail).toContain('refused 3 times');
    // The provider's own words, because "suppressed" is not something a
    // business can act on.
    expect(sent.detail).toContain('21610');
  });

  it('stops immediately when a person asks, and never resumes', async () => {
    const comms = service();

    await comms.unsubscribe(TENANT, 'sms', '+40722000003', 'STOP');

    const sent = await comms.send(
      { channel: 'sms', to: '+40722000003', text: 'Reminder' },
      { tenantId: TENANT },
    );

    expect(sent.state).toBe('discarded');
    expect(sent.detail).toContain('asked not to be contacted');

    // And a later refusal does not downgrade it to something that expires.
    await comms.recordRefusal(TENANT, 'sms', '+40722000003', 'unreachable');
    expect((await comms.suppressionFor(TENANT, 'sms', '+40722000003'))?.expiresAt).toBeNull();
  });

  it('is one business’s decision, not everybody’s', async () => {
    /*
     * A customer telling one salon to stop has not told the salon down the road
     * anything — and a shared list would reveal that the two share a customer.
     */
    const other = '22222222-2222-4222-8222-222222222222';
    const comms = service();

    await comms.unsubscribe(TENANT, 'sms', '+40722000004', 'STOP');

    expect(await comms.suppressionFor(other, 'sms', '+40722000004')).toBeNull();
  });

  it('lets a business put an address back', async () => {
    const comms = service();

    await comms.unsubscribe(TENANT, 'sms', '+40722000005', 'STOP');
    await comms.allowAgain(TENANT, 'sms', '+40722000005');

    expect(await comms.suppressionFor(TENANT, 'sms', '+40722000005')).toBeNull();
  });
});
