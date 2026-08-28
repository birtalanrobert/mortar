import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDataSource } from '@birtalanrobert/database';
import type { DataSource } from 'typeorm';
import { CommsService } from './comms.service';
import { parseMime } from './inbound/mime';
import { MessageLog } from './message-log.entity';
import { CreateMessageLog1787813849846 } from './migrations/1787813849846-CreateMessageLog';
import { NoopMessagePort, type MessagePort } from './outbound/port';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SECRET = 'a-secret-that-is-at-least-thirty-two-characters';

let dataSource: DataSource;

beforeEach(async () => {
  dataSource ??= await createTestDataSource([MessageLog], {
    // The real migration, not `synchronize`: the partial unique index is the
    // part that matters here and synchronize does not create it.
    migrations: [CreateMessageLog1787813849846],
  });
  await dataSource.getRepository(MessageLog).clear();
});

afterAll(async () => {
  if (dataSource?.isInitialized) await dataSource.destroy();
});

function service(ports: Partial<Record<'email' | 'sms', MessagePort>> = {}) {
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
