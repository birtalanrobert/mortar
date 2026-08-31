import { describe, expect, it, vi } from 'vitest';
import type { Resend } from 'resend';
import { ResendMessagePort } from './resend';

/**
 * The vendor's client, faked at its own surface.
 *
 * The alternative — stubbing global `fetch` and asserting the JSON that goes
 * over the wire — tests the SDK rather than this adapter, and would break every
 * time they renamed a field we do not set. What matters here is what the port
 * asks the client for.
 */
function client(answer: { data?: { id: string } | null; error?: { message: string } | null } = {}) {
  const send = vi.fn(async () => ({
    data: answer.data === undefined ? { id: 'ee-1' } : answer.data,
    error: answer.error ?? null,
  }));

  return { send, resend: { emails: { send } } as unknown as Resend };
}

const port = (resend: Resend, overrides = {}) =>
  new ResendMessagePort({
    apiKey: 're_test',
    from: 'no-reply@mail.example.com',
    client: resend,
    ...overrides,
  });

describe('ResendMessagePort', () => {
  it('sends, and returns the provider id the receipt will arrive under', async () => {
    const { send, resend } = client({ data: { id: 'ee-7' } });

    const result = await port(resend).send({
      channel: 'email',
      to: 'ion@example.ro',
      subject: 'Documents',
      text: 'Please send these.',
    });

    expect(result.providerMessageId).toBe('ee-7');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'no-reply@mail.example.com',
        to: ['ion@example.ro'],
        subject: 'Documents',
        text: 'Please send these.',
      }),
    );
  });

  it('lets a message name its own sender and reply address', async () => {
    const { send, resend } = client();

    await port(resend).send({
      channel: 'email',
      to: 'ion@example.ro',
      // How a message is branded as the firm without the firm's domain being
      // one we can sign for: their name in front, their address to reply to.
      from: 'Contabil SRL <no-reply@mail.example.com>',
      replyTo: 'birou@contabil.ro',
      text: 'Please send these.',
    });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'Contabil SRL <no-reply@mail.example.com>',
        replyTo: 'birou@contabil.ro',
      }),
    );
  });

  it('passes attachments to the client as they are', async () => {
    const { send, resend } = client();
    const content = Buffer.from('PK');

    await port(resend).send({
      channel: 'email',
      to: 'firm@example.ro',
      text: 'Attached.',
      attachments: [{ filename: 'pack.zip', content, contentType: 'application/zip' }],
    });

    // The SDK takes a Buffer and encodes it. Encoding here as well would send
    // base64 of base64, which arrives as a file nobody can open.
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [{ filename: 'pack.zip', content, contentType: 'application/zip' }],
      }),
    );
  });

  it('carries our reference in a header, so a receipt can be matched', async () => {
    const { send, resend } = client();

    await port(resend).send({
      channel: 'email',
      to: 'ion@example.ro',
      text: 'Hello.',
      reference: 'request:abc',
    });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { 'X-Entity-Ref-ID': 'request:abc' } }),
    );
  });

  it('refuses an attachment over the limit without asking the provider', async () => {
    const { send, resend } = client();

    await expect(
      port(resend).send({
        channel: 'email',
        to: 'firm@example.ro',
        text: 'Attached.',
        attachments: [{ filename: 'big.zip', content: Buffer.alloc(11 * 1024 * 1024) }],
      }),
    ).rejects.toThrow(/over the limit/);

    // `CommsService` guards this too. A port used directly - a script, the next
    // consumer - has no such guard, and the failure it prevents is a silent
    // late bounce.
    expect(send).not.toHaveBeenCalled();
  });

  it('throws with the provider own words, which is what support reads', async () => {
    const { resend } = client({ data: null, error: { message: 'The domain is not verified.' } });

    await expect(
      port(resend).send({ channel: 'email', to: 'ion@example.ro', text: 'Hello.' }),
    ).rejects.toThrow(/The domain is not verified/);
  });

  it('treats an answer with no id as a refusal', async () => {
    // A response that parsed but promised nothing. Returning success here would
    // record a message as accepted that the provider never took.
    const { resend } = client({ data: null });

    await expect(
      port(resend).send({ channel: 'email', to: 'ion@example.ro', text: 'Hello.' }),
    ).rejects.toThrow(/refused/);
  });

  it('gives up on a provider that never answers', async () => {
    const resend = { emails: { send: () => new Promise(() => {}) } } as unknown as Resend;

    /*
     * The SDK sets no timeout of its own, and a professional who has just
     * pressed send is waiting on this. Ten seconds by default; ten milliseconds
     * here so the test does not wait either.
     */
    await expect(
      port(resend, { timeoutMs: 10 }).send({
        channel: 'email',
        to: 'ion@example.ro',
        text: 'Hello.',
      }),
    ).rejects.toThrow(/did not answer/);
  });

  it('will not be asked to send a text message', async () => {
    const { send, resend } = client();

    await expect(
      port(resend).send({ channel: 'sms', to: '+40712345678', text: 'Hello.' }),
    ).rejects.toThrow(/not sms/);
    expect(send).not.toHaveBeenCalled();
  });
});
