import { afterEach, describe, expect, it } from 'vitest';
import { SMTPServer } from 'smtp-server';
import type { AddressInfo } from 'node:net';
import { SmtpMessagePort } from './smtp';

interface Received {
  from: string;
  to: string[];
  raw: string;
}

/**
 * A real SMTP server, in this process, on a port the operating system picks.
 *
 * Not a mock of `sendMail`. Almost everything worth asserting about this
 * adapter — that a rejected recipient is a failure rather than a success, that
 * the reference header actually travels, that a server which never speaks is
 * abandoned rather than waited on — only exists once something is answering on
 * a socket. Mocking the client would assert the shape of an argument and prove
 * nothing about the protocol.
 *
 * Port 0 rather than one from a project's block: these run anywhere, including
 * alongside another suite doing the same thing.
 */
async function server(
  options: { rejectRecipient?: boolean; silent?: boolean; startTls?: boolean } = {},
): Promise<{ url: string; received: Received[]; close: () => Promise<void> }> {
  const received: Received[] = [];

  const smtp = new SMTPServer({
    authOptional: true,
    /*
     * No STARTTLS unless a test asks for it, which is also how Mailpit and
     * every other local mail catcher arrives: with no certificate configured,
     * there is nothing to offer. The one test that does ask for it uses the
     * bundled self-signed certificate, which is expired — and that is the
     * point of it.
     */
    hideSTARTTLS: !options.startTls,
    // A greeting is the first thing a client waits for, so withholding it is
    // how a stalled server is simulated without a firewall.
    ...(options.silent ? { onConnect: () => {} } : {}),
    onRcptTo: (address, _session, callback) => {
      if (options.rejectRecipient) {
        callback(new Error('550 No such recipient here.'));
        return;
      }
      callback();
    },
    onData: (stream, session, callback) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        received.push({
          from: session.envelope.mailFrom === false ? '' : session.envelope.mailFrom.address,
          to: session.envelope.rcptTo.map((recipient) => recipient.address),
          raw: Buffer.concat(chunks).toString('utf8'),
        });
        callback();
      });
    },
  });

  await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve));
  const { port } = smtp.server.address() as AddressInfo;

  return {
    url: `smtp://127.0.0.1:${port}`,
    received,
    close: () => new Promise<void>((resolve) => smtp.close(() => resolve())),
  };
}

let ports: SmtpMessagePort[] = [];

const portFor = (url: string, overrides: Record<string, unknown> = {}) => {
  const created = new SmtpMessagePort({
    url,
    from: 'Slotline <no-reply@mail.example.com>',
    ...overrides,
  });
  ports.push(created);
  return created;
};

afterEach(() => {
  // Otherwise a transport holding a socket keeps the suite's process alive
  // after the assertions have all passed, which reads as a hung test.
  for (const port of ports) port.close();
  ports = [];
});

describe('SmtpMessagePort', () => {
  it('delivers, and returns the message id a bounce would quote', async () => {
    const smtp = await server();

    try {
      const result = await portFor(smtp.url).send({
        channel: 'email',
        to: 'ana@salon-aurora.ro',
        subject: 'You have been invited',
        text: 'Follow this link.',
      });

      expect(smtp.received).toHaveLength(1);
      expect(smtp.received[0]?.to).toEqual(['ana@salon-aurora.ro']);
      expect(smtp.received[0]?.raw).toContain('You have been invited');
      expect(result.providerMessageId).toMatch(/^<.+@.+>$/);
    } finally {
      await smtp.close();
    }
  });

  it('lets a message name its own sender and reply address', async () => {
    const smtp = await server();

    try {
      await portFor(smtp.url).send({
        channel: 'email',
        to: 'ana@salon-aurora.ro',
        // How a message is branded as the business without their domain being
        // one we can sign for: their name in front, their address to reply to.
        from: 'Salon Aurora <no-reply@mail.example.com>',
        replyTo: 'contact@salon-aurora.ro',
        text: 'Hello.',
      });

      expect(smtp.received[0]?.raw).toContain('Salon Aurora <no-reply@mail.example.com>');
      expect(smtp.received[0]?.raw).toContain('contact@salon-aurora.ro');
    } finally {
      await smtp.close();
    }
  });

  it('carries our reference in a header, so a receipt can be matched', async () => {
    const smtp = await server();

    try {
      await portFor(smtp.url).send({
        channel: 'email',
        to: 'ana@salon-aurora.ro',
        text: 'Hello.',
        reference: 'invitation:abc',
      });

      expect(smtp.received[0]?.raw).toContain('X-Entity-Ref-ID: invitation:abc');
    } finally {
      await smtp.close();
    }
  });

  it('attaches a file without encoding it twice', async () => {
    const smtp = await server();

    try {
      await portFor(smtp.url).send({
        channel: 'email',
        to: 'ana@salon-aurora.ro',
        text: 'Attached.',
        attachments: [
          { filename: 'receipt.txt', content: Buffer.from('paid'), contentType: 'text/plain' },
        ],
      });

      const raw = smtp.received[0]?.raw ?? '';
      expect(raw).toContain('filename=receipt.txt');
      // `paid` in base64. Encoding here as well would send base64 of base64,
      // which arrives as a file nobody can open.
      expect(raw).toContain(Buffer.from('paid').toString('base64'));
    } finally {
      await smtp.close();
    }
  });

  /**
   * The failure a mock cannot produce.
   *
   * A server can accept the conversation and refuse the address, and
   * `sendMail` resolves in that case. Treating it as a success writes
   * "delivered" against a message the server explicitly refused.
   */
  it('fails when the server accepts the conversation but refuses the recipient', async () => {
    const smtp = await server({ rejectRecipient: true });

    try {
      await expect(
        portFor(smtp.url).send({
          channel: 'email',
          to: 'nobody@salon-aurora.ro',
          text: 'Hello.',
        }),
      ).rejects.toThrow(/SMTP refused the message/);

      expect(smtp.received).toHaveLength(0);
    } finally {
      await smtp.close();
    }
  });

  it('gives up on a server that opens the socket and never speaks', async () => {
    const smtp = await server({ silent: true });

    try {
      await expect(
        portFor(smtp.url, { timeoutMs: 300 }).send({
          channel: 'email',
          to: 'ana@salon-aurora.ro',
          text: 'Hello.',
        }),
      ).rejects.toThrow(/SMTP refused the message/);
    } finally {
      await smtp.close();
    }
  });

  /**
   * The secure default, pinned.
   *
   * `smtp-server` ships a self-signed certificate that expired some time ago,
   * which makes this free to assert: a server offering STARTTLS with a
   * certificate the system does not trust must be refused, because a
   * certificate nobody checks makes the upgrade an encrypted conversation with
   * whoever answered.
   */
  it('refuses a certificate the system does not trust', async () => {
    const smtp = await server({ startTls: true });

    try {
      await expect(
        portFor(smtp.url).send({
          channel: 'email',
          to: 'ana@salon-aurora.ro',
          text: 'Hello.',
        }),
      ).rejects.toThrow(/SMTP refused the message/);

      expect(smtp.received).toHaveLength(0);
    } finally {
      await smtp.close();
    }
  });

  it('accepts one when the deployment has said so, for a catcher or a private relay', async () => {
    const smtp = await server({ startTls: true });

    try {
      await portFor(smtp.url, { allowSelfSignedCertificate: true }).send({
        channel: 'email',
        to: 'ana@salon-aurora.ro',
        text: 'Hello.',
      });

      expect(smtp.received).toHaveLength(1);
    } finally {
      await smtp.close();
    }
  });

  it('refuses an attachment over the limit without opening a connection', async () => {
    // No server at all: reaching one would be the failure.
    await expect(
      portFor('smtp://127.0.0.1:1').send({
        channel: 'email',
        to: 'ana@salon-aurora.ro',
        text: 'Attached.',
        attachments: [{ filename: 'big.zip', content: Buffer.alloc(11 * 1024 * 1024) }],
      }),
    ).rejects.toThrow(/over the limit/);
  });

  it('refuses to pretend it can send an SMS', async () => {
    await expect(
      portFor('smtp://127.0.0.1:1').send({
        channel: 'sms',
        to: '+40722123456',
        text: 'Hello.',
      }),
    ).rejects.toThrow(/SMTP sends email/);
  });
});
