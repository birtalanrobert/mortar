import { describe, expect, it, vi } from 'vitest';
import type { Twilio } from 'twilio';
import { TwilioMessagePort } from './twilio';

/**
 * The vendor's client, faked at its own surface.
 *
 * Twilio's SDK talks through axios rather than `fetch`, so there is no global
 * to stub — and stubbing its transport would test the SDK's request building
 * rather than this adapter. What matters here is what the port asks for and
 * what it makes of the answer.
 */
function client(answer: { sid?: string; numSegments?: string } | Error = {}) {
  const create = vi.fn(async () => {
    if (answer instanceof Error) throw answer;
    return { sid: answer.sid ?? 'SM1', numSegments: answer.numSegments ?? '1' };
  });

  return { create, twilio: { messages: { create } } as unknown as Twilio };
}

const port = (twilio: Twilio, overrides = {}) =>
  new TwilioMessagePort({
    accountSid: 'AC1',
    authToken: 'token',
    messagingServiceSid: 'MG1',
    client: twilio,
    ...overrides,
  });

describe('TwilioMessagePort', () => {
  it('sends through the messaging service and returns what it charged', async () => {
    const { create, twilio } = client({ sid: 'SM9', numSegments: '2' });

    const result = await port(twilio).send({
      channel: 'sms',
      to: '+40712345678',
      text: 'Two segments worth of reminder.',
    });

    expect(result).toMatchObject({ providerMessageId: 'SM9', segments: 2 });
    expect(create).toHaveBeenCalledWith({
      to: '+40712345678',
      body: 'Two segments worth of reminder.',
      messagingServiceSid: 'MG1',
    });
  });

  it('falls back to a single sending number when there is no service', async () => {
    const { create, twilio } = client();

    await port(twilio, { messagingServiceSid: undefined, from: '+40711111111' }).send({
      channel: 'sms',
      to: '+40712345678',
      text: 'Hello.',
    });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ from: '+40711111111' }));
  });

  it('refuses to exist without a sender', () => {
    const { twilio } = client();

    // A port with no sender fails twelve days into a cadence, on the one
    // message a firm is spending their client's goodwill on. Boot is the right
    // moment to find out.
    expect(() => port(twilio, { messagingServiceSid: undefined, from: undefined })).toThrow(
      /messaging service SID or a sending number/,
    );
  });

  it('assumes one segment when the provider does not say', async () => {
    const { twilio } = client({ numSegments: undefined });

    const result = await port(twilio).send({ channel: 'sms', to: '+40712345678', text: 'Hello.' });

    // Under-counting the ledger is worse than over-counting: a firm whose
    // credit never runs down finds out at the invoice.
    expect(result.segments).toBe(1);
  });

  it('throws with the code and the sentence, which is what support reads', async () => {
    const refusal = Object.assign(new Error('Permission to send to this region is disabled.'), {
      status: 400,
      code: 21408,
    });

    await expect(
      port(client(refusal).twilio).send({ channel: 'sms', to: '+40712345678', text: 'Hello.' }),
    ).rejects.toThrow(/21408.*Permission to send to this region/);
  });

  it('will not be asked to send an email', async () => {
    const { create, twilio } = client();

    await expect(
      port(twilio).send({ channel: 'email', to: 'ion@example.ro', text: 'Hi.' }),
    ).rejects.toThrow(/not email/);
    expect(create).not.toHaveBeenCalled();
  });
});
