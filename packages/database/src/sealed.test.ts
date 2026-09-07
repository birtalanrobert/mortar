import { describe, expect, it } from 'vitest';

import { isSealed, openSecret, sealSecret, sealingKey, secretsMatch } from './sealed';

const KEY = sealingKey('0'.repeat(64));

describe('a secret in a column', () => {
  it('comes back out as it went in', () => {
    const sealed = sealSecret('1//refresh-token-from-google', KEY);

    expect(sealed).not.toContain('refresh-token');
    expect(openSecret(sealed, KEY)).toBe('1//refresh-token-from-google');
  });

  it('is different every time, so two identical secrets do not look identical', () => {
    /*
     * A deterministic sealing would let anybody with the table see which two
     * businesses hold the same credential — and reusing a nonce with GCM is the
     * mistake that loses the key outright.
     */
    expect(sealSecret('same', KEY)).not.toBe(sealSecret('same', KEY));
  });

  it('refuses to open something that has been tampered with', () => {
    const sealed = sealSecret('a-token', KEY);
    const [version, nonce, tag] = sealed.split('.');

    const meddled = [version, nonce, tag, Buffer.from('not-a-token').toString('base64url')].join(
      '.',
    );

    // Authenticated, so this fails rather than decrypting to rubbish that some
    // code path then sends to a provider as a credential.
    expect(() => openSecret(meddled, KEY)).toThrow();
  });

  it('refuses a key that is not the right size, loudly', () => {
    /*
     * A short key silently padded is a key that looks like it works until the
     * day it does not, and by then every sealed row is unreadable.
     */
    expect(() => sealingKey('too-short')).toThrow(/32 bytes/);
  });

  it('takes a key as hex or as base64', () => {
    const hex = sealingKey('ab'.repeat(32));
    const base64 = sealingKey(Buffer.alloc(32, 0xab).toString('base64'));

    expect(openSecret(sealSecret('x', hex), base64)).toBe('x');
  });

  it('says whether a stored value is sealed without opening it', () => {
    expect(isSealed(sealSecret('x', KEY))).toBe(true);
    expect(isSealed('plain-text-from-before-this-existed')).toBe(false);
  });

  it('compares secrets without leaking their length one character at a time', () => {
    expect(secretsMatch('abc', 'abc')).toBe(true);
    expect(secretsMatch('abc', 'abd')).toBe(false);
    expect(secretsMatch('abc', 'abcd')).toBe(false);
  });
});
