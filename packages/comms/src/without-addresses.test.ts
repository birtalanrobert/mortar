import { describe, expect, it } from 'vitest';
import { withoutAddresses } from './without-addresses';

describe('free text without its addresses', () => {
  it('strikes an email address however a provider writes it, and keeps the reason', () => {
    expect(
      withoutAddresses('550 5.1.1 <ana.pop+x@mail.example.com>: Recipient address rejected'),
    ).toBe('550 5.1.1 <[address]>: Recipient address rejected');
    expect(withoutAddresses('"Ana" <ana@example.ro>, (ion@example.hu); bo@sub.example.co.uk')).toBe(
      '"Ana" <[address]>, ([address]); [address]',
    );
  });

  it('strikes a telephone number written as E.164', () => {
    expect(withoutAddresses('21610: Attempt to send to unsubscribed recipient +40712345678')).toBe(
      '21610: Attempt to send to unsubscribed recipient [address]',
    );
  });

  it('leaves what names nobody alone', () => {
    // A code, a count, a host alone, and a short number are not addresses.
    for (const text of [
      'Connection timed out after 30000 ms',
      'smtp.example.com refused: 421 Too many connections',
      'Attachments total 12 MB, over the 10 MB limit.',
      'Error +123',
      'Your Holdfast password was reset',
    ]) {
      expect(withoutAddresses(text), text).toBe(text);
    }
  });
});
