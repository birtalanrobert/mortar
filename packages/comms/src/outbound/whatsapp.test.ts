import { describe, expect, it, vi } from 'vitest';

import { FallbackMessagePort } from './fallback';
import { NOT_ON_WHATSAPP, OUTSIDE_WINDOW, WhatsAppMessagePort, WhatsAppRefused } from './whatsapp';
import type { MessagePort, OutboundMessage, SendResult } from './port';

/** Twilio's client, reduced to the one call this port makes. */
function fakeTwilio(behaviour?: (payload: Record<string, unknown>) => unknown) {
  const created: Array<Record<string, unknown>> = [];

  return {
    created,
    client: {
      messages: {
        create: async (payload: Record<string, unknown>) => {
          created.push(payload);
          const answer = behaviour?.(payload);

          if (answer instanceof Error) throw answer;

          return (answer as { sid: string }) ?? { sid: 'SM1' };
        },
      },
    } as never,
  };
}

const message: OutboundMessage = {
  channel: 'whatsapp',
  to: '+40722123456',
  text: 'Your appointment is tomorrow at ten.',
};

describe('sending on WhatsApp', () => {
  it('addresses the number the way Twilio expects', () => {
    const twilio = fakeTwilio();
    const port = new WhatsAppMessagePort({
      accountSid: 'AC',
      authToken: 'token',
      from: '+40722000000',
      client: twilio.client,
    });

    return port.send(message).then(() => {
      /*
       * A plain `+40…` sent to this endpoint is delivered as an SMS, at SMS
       * prices, and looks like a success everywhere. The prefix is applied here
       * so no caller has to remember it.
       */
      expect(twilio.created[0]).toMatchObject({
        to: 'whatsapp:+40722123456',
        from: 'whatsapp:+40722000000',
      });
    });
  });

  it('sends an approved template when one is given, not the plain words', async () => {
    const twilio = fakeTwilio();
    const port = new WhatsAppMessagePort({
      accountSid: 'AC',
      authToken: 'token',
      from: '+40722000000',
      client: twilio.client,
    });

    await port.send({
      ...message,
      template: { id: 'HX1', variables: { '1': 'Ana', '2': '10:00' } },
    });

    /*
     * Outside twenty-four hours of the customer's last message only an approved
     * template may be sent — which a reminder always is.
     */
    expect(twilio.created[0]).toMatchObject({
      contentSid: 'HX1',
      contentVariables: JSON.stringify({ '1': 'Ana', '2': '10:00' }),
    });

    expect(twilio.created[0]!.body).toBeUndefined();
  });

  it('counts one, because WhatsApp is billed per conversation', async () => {
    const twilio = fakeTwilio();
    const port = new WhatsAppMessagePort({
      accountSid: 'AC',
      authToken: 'token',
      from: '+40722000000',
      client: twilio.client,
    });

    const sent = await port.send({ ...message, text: 'x'.repeat(900) });

    // Nine hundred characters is seven SMS segments and one WhatsApp message.
    expect(sent.segments).toBe(1);
  });

  it('refuses to be built without a registered sender', () => {
    /*
     * A configuration mistake is a far better thing to find at boot than on the
     * first reminder somebody was relying on.
     */
    expect(
      () =>
        new WhatsAppMessagePort({
          accountSid: 'AC',
          authToken: 'token',
          from: '',
          client: fakeTwilio().client,
        }),
    ).toThrow(/registered sender/);
  });

  it('says which refusal it was, because two of them mean try elsewhere', async () => {
    const twilio = fakeTwilio(() =>
      Object.assign(new Error('not on WhatsApp'), {
        code: NOT_ON_WHATSAPP,
        status: 400,
      }),
    );

    const port = new WhatsAppMessagePort({
      accountSid: 'AC',
      authToken: 'token',
      from: '+40722000000',
      client: twilio.client,
    });

    await expect(port.send(message)).rejects.toMatchObject({
      name: 'WhatsAppRefused',
      code: NOT_ON_WHATSAPP,
    });
  });
});

describe('falling back to another channel', () => {
  const sms: MessagePort & { sent: OutboundMessage[] } = {
    channel: 'sms',
    sent: [],
    async send(outbound: OutboundMessage): Promise<SendResult> {
      this.sent.push(outbound);
      return { providerMessageId: 'SM2', segments: 1, acceptedAt: new Date() };
    },
  };

  const refusing = (code: number | undefined): MessagePort => ({
    channel: 'whatsapp',
    async send() {
      throw new WhatsAppRefused('refused', code);
    },
  });

  it('sends by SMS when the number is not on WhatsApp', async () => {
    sms.sent.length = 0;
    const told = vi.fn();

    const port = new FallbackMessagePort(refusing(NOT_ON_WHATSAPP), sms, told);
    const sent = await port.send(message);

    // A customer who is not on WhatsApp still has an appointment tomorrow.
    expect(sent.providerMessageId).toBe('SM2');
    expect(sms.sent[0]).toMatchObject({ channel: 'sms', text: message.text });
    expect(told).toHaveBeenCalled();
  });

  it('sends by SMS when the window has closed with no template', async () => {
    sms.sent.length = 0;

    const port = new FallbackMessagePort(refusing(OUTSIDE_WINDOW), sms);
    await port.send(message);

    expect(sms.sent).toHaveLength(1);
  });

  it('drops the template, which belonged to the other channel', async () => {
    sms.sent.length = 0;

    const port = new FallbackMessagePort(refusing(NOT_ON_WHATSAPP), sms);
    await port.send({ ...message, template: { id: 'HX1' } });

    // An SMS port handed one would ignore it or send its identifier as the
    // message, which is worse than either.
    expect(sms.sent[0]!.template).toBeUndefined();
  });

  it('does not fall back on a failure another channel cannot fix', async () => {
    sms.sent.length = 0;

    /*
     * A wrong credential, a provider having an afternoon, a malformed request.
     * Silently sending everything by SMS because a token expired is a bill
     * nobody expected and a fault nobody saw.
     */
    const port = new FallbackMessagePort(refusing(20003), sms);

    await expect(port.send(message)).rejects.toThrow();
    expect(sms.sent).toHaveLength(0);
  });

  it('names the channel that actually carried it', async () => {
    sms.sent.length = 0;

    const port = new FallbackMessagePort(refusing(NOT_ON_WHATSAPP), sms);
    const sent = await port.send(message);

    // Without this the diversion is invisible above the port: a log saying
    // WhatsApp for a message that went by SMS, billed by the segment.
    expect(sent.channel).toBe('sms');
  });

  it('says nothing about the channel when the preferred one worked', async () => {
    const working: MessagePort = {
      channel: 'whatsapp',
      async send() {
        return { providerMessageId: 'WA1', segments: 1, acceptedAt: new Date() };
      },
    };

    const sent = await new FallbackMessagePort(working, sms).send(message);

    expect(sent.channel).toBeUndefined();
  });

  it('declares where it may divert to, so a caller can check first', () => {
    const port = new FallbackMessagePort(refusing(NOT_ON_WHATSAPP), sms);

    // Read before the send, by whoever holds the list of addresses that have
    // asked not to be written to.
    expect(port.channel).toBe('whatsapp');
    expect(port.fallbackChannel).toBe('sms');
  });

  it('does not fall back on anything that is not a WhatsApp refusal at all', async () => {
    sms.sent.length = 0;

    const broken: MessagePort = {
      channel: 'whatsapp',
      async send() {
        throw new Error('the network went away');
      },
    };

    await expect(new FallbackMessagePort(broken, sms).send(message)).rejects.toThrow();
    expect(sms.sent).toHaveLength(0);
  });
});
