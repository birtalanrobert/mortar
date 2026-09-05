import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TwilioReceipts } from './twilio';

const TOKEN = 'an-auth-token';
const URL = 'https://api.example.com/webhooks/sms';

/** Twilio's own scheme, written out here so the test does not trust the code. */
const sign = (url: string, params: Record<string, string>): string => {
  const payload = Object.keys(params)
    .sort()
    .reduce((joined, key) => joined + key + params[key], url);

  return createHmac('sha1', TOKEN).update(Buffer.from(payload, 'utf8')).digest('base64');
};

describe('Twilio delivery receipts', () => {
  const receipts = new TwilioReceipts(TOKEN);

  it('accepts a properly signed delivery', () => {
    const params = { MessageSid: 'SM123', MessageStatus: 'delivered' };

    expect(receipts.verify(URL, params, sign(URL, params))).toEqual({
      providerMessageId: 'SM123',
      state: 'delivered',
      detail: undefined,
    });
  });

  it('refuses one signed with the wrong token', () => {
    const params = { MessageSid: 'SM123', MessageStatus: 'delivered' };
    const forged = createHmac('sha1', 'not-the-token').update(URL).digest('base64');

    /*
     * The endpoint is unauthenticated by necessity — Twilio has no credential
     * of ours to present — so the signature *is* the authentication. Without
     * this, anybody who learns the URL can mark any message delivered, or
     * bounce a customer's address and stop them being written to again.
     */
    expect(receipts.verify(URL, params, forged)).toBeUndefined();
  });

  it('refuses one with no signature at all', () => {
    expect(
      receipts.verify(URL, { MessageSid: 'SM123', MessageStatus: 'delivered' }, undefined),
    ).toBeUndefined();
  });

  it('refuses one signed for a different address', () => {
    // The signature covers the URL, so a callback replayed against another
    // endpoint does not verify.
    const params = { MessageSid: 'SM123', MessageStatus: 'delivered' };
    const elsewhere = sign('https://api.example.com/webhooks/other', params);

    expect(receipts.verify(URL, params, elsewhere)).toBeUndefined();
  });

  it('refuses one whose parameters were changed after signing', () => {
    const params = { MessageSid: 'SM123', MessageStatus: 'delivered' };
    const signature = sign(URL, params);

    expect(receipts.verify(URL, { ...params, MessageStatus: 'failed' }, signature)).toBeUndefined();
  });

  it('separates a refused address from a failed attempt', () => {
    /*
     * `undelivered` reached the network and was refused — a disconnected
     * number, a handset that will never come back — which is a fact about the
     * *address* and a reason to stop using it. A failure is a fact about the
     * attempt.
     */
    const undelivered = { MessageSid: 'SM1', MessageStatus: 'undelivered', ErrorCode: '30003' };
    expect(receipts.verify(URL, undelivered, sign(URL, undelivered))?.state).toBe('bounced');

    const failed = { MessageSid: 'SM2', MessageStatus: 'failed' };
    expect(receipts.verify(URL, failed, sign(URL, failed))?.state).toBe('failed');
  });

  it('carries the provider’s own words about a failure', () => {
    const params = {
      MessageSid: 'SM1',
      MessageStatus: 'failed',
      ErrorCode: '21610',
      ErrorMessage: 'Attempt to send to unsubscribed recipient',
    };

    // "21610: Attempt to send to unsubscribed recipient" is something a person
    // can act on. "Failed" is not.
    expect(receipts.verify(URL, params, sign(URL, params))?.detail).toContain('21610');
    expect(receipts.verify(URL, params, sign(URL, params))?.detail).toContain('unsubscribed');
  });

  it('ignores the statuses on the way to delivery', () => {
    /*
     * `queued`, `sending` and `sent` are not news: the message was recorded as
     * accepted when it was handed over. Writing them would be a row that says
     * nothing and a write per message per hop.
     */
    for (const status of ['queued', 'sending', 'sent', 'accepted']) {
      const params = { MessageSid: 'SM1', MessageStatus: status };
      expect(receipts.verify(URL, params, sign(URL, params))).toBeUndefined();
    }
  });

  it('ignores a callback that names no message', () => {
    const params = { MessageStatus: 'delivered' };
    expect(receipts.verify(URL, params, sign(URL, params))).toBeUndefined();
  });
});
