import { describe, expect, it } from 'vitest';
import { EnvelopeCrypto, LocalMasterKey, generateMasterKey, sameWrappedKey } from './envelope';

const master = new LocalMasterKey(generateMasterKey());
const crypto = new EnvelopeCrypto(master);

describe('data keys', () => {
  it('wraps a key that can be opened again', async () => {
    const { envelope, dataKey } = await crypto.createDataKey();

    expect(await crypto.openDataKey(envelope)).toEqual(dataKey);
    expect(envelope.keyId).toBe('local');
  });

  it('never produces the same key twice', async () => {
    const a = await crypto.createDataKey();
    const b = await crypto.createDataKey();

    expect(a.dataKey.equals(b.dataKey)).toBe(false);
  });

  it('refuses a wrapped key from another master key', async () => {
    const { envelope } = await crypto.createDataKey();
    const stranger = new EnvelopeCrypto(new LocalMasterKey(generateMasterKey()));

    // The whole point of erasure by key destruction: without the master key
    // the wrapped key is inert.
    await expect(stranger.openDataKey(envelope)).rejects.toThrow();
  });

  it('refuses a wrapped key that has been altered', async () => {
    const { envelope } = await crypto.createDataKey();
    const bytes = Buffer.from(envelope.wrappedKey, 'base64');
    flip(bytes, bytes.length - 1);

    await expect(
      crypto.openDataKey({ ...envelope, wrappedKey: bytes.toString('base64') }),
    ).rejects.toThrow();
  });

  it('refuses something that is not a wrapped key at all', async () => {
    await expect(crypto.openDataKey({ wrappedKey: 'nonsense', keyId: 'local' })).rejects.toThrow();
  });

  it('refuses a master key of the wrong size', () => {
    expect(() => new LocalMasterKey('c2hvcnQ=')).toThrow();
  });
});

describe('file contents', () => {
  it('round-trips', async () => {
    const { dataKey } = await crypto.createDataKey();
    const plaintext = Buffer.from('Extras de cont, ianuarie. Situație financiară.', 'utf8');

    const sealed = crypto.encrypt(dataKey, plaintext);

    expect(sealed.equals(plaintext)).toBe(false);
    expect(crypto.decrypt(dataKey, sealed)).toEqual(plaintext);
  });

  it('round-trips an empty file', async () => {
    const { dataKey } = await crypto.createDataKey();

    // A zero-byte upload is a real thing a real client does, and it must fail
    // validation rather than the cipher.
    expect(crypto.decrypt(dataKey, crypto.encrypt(dataKey, Buffer.alloc(0)))).toHaveLength(0);
  });

  it('uses a fresh initialisation vector every time', async () => {
    const { dataKey } = await crypto.createDataKey();
    const plaintext = Buffer.from('the same bytes');

    const first = crypto.encrypt(dataKey, plaintext);
    const second = crypto.encrypt(dataKey, plaintext);

    // Reusing an IV under one key in GCM leaks the key stream and, with two
    // messages, the authentication key itself.
    expect(first.subarray(0, 12).equals(second.subarray(0, 12))).toBe(false);
    expect(first.equals(second)).toBe(false);
  });

  it('refuses a wrong key', async () => {
    const { dataKey } = await crypto.createDataKey();
    const other = await crypto.createDataKey();
    const sealed = crypto.encrypt(dataKey, Buffer.from('secret'));

    expect(() => crypto.decrypt(other.dataKey, sealed)).toThrow();
  });

  it('detects a tampered ciphertext', async () => {
    const { dataKey } = await crypto.createDataKey();
    const sealed = crypto.encrypt(dataKey, Buffer.from('a bank statement'));
    flip(sealed, sealed.length - 1);

    // Authenticated encryption, so this is detection rather than garbage out.
    expect(() => crypto.decrypt(dataKey, sealed)).toThrow();
  });

  it('detects a tampered authentication tag', async () => {
    const { dataKey } = await crypto.createDataKey();
    const sealed = crypto.encrypt(dataKey, Buffer.from('a bank statement'));
    // Inside the authentication tag, which begins at byte 12.
    flip(sealed, 13);

    expect(() => crypto.decrypt(dataKey, sealed)).toThrow();
  });

  it('refuses a payload too short to contain a header', async () => {
    const { dataKey } = await crypto.createDataKey();

    expect(() => crypto.decrypt(dataKey, Buffer.alloc(4))).toThrow();
  });

  it('binds the object key in, so a moved file will not open', async () => {
    const { dataKey } = await crypto.createDataKey();
    const sealed = crypto.encrypt(dataKey, Buffer.from('statement'), 'tenants/a/r/1.pdf');

    expect(crypto.decrypt(dataKey, sealed, 'tenants/a/r/1.pdf').toString()).toBe('statement');
    // A ciphertext copied under another tenant's prefix must fail rather than
    // decrypt into the wrong hands.
    expect(() => crypto.decrypt(dataKey, sealed, 'tenants/b/r/1.pdf')).toThrow();
  });

  it('says the same thing however decryption failed', async () => {
    const { dataKey } = await crypto.createDataKey();
    const other = await crypto.createDataKey();
    const sealed = crypto.encrypt(dataKey, Buffer.from('x'), 'tenants/a/r/1.pdf');

    const wrongKey = attempt(() => crypto.decrypt(other.dataKey, sealed, 'tenants/a/r/1.pdf'));
    const wrongAad = attempt(() => crypto.decrypt(dataKey, sealed, 'tenants/b/r/1.pdf'));

    // Distinguishing them tells anyone probing which half of their guess was
    // right.
    expect(wrongKey).toBe(wrongAad);
  });
});

describe('sameWrappedKey', () => {
  it('recognises a key as itself', async () => {
    const { envelope } = await crypto.createDataKey();

    expect(sameWrappedKey(envelope.wrappedKey, envelope.wrappedKey)).toBe(true);
  });

  it('separates two different keys', async () => {
    const a = await crypto.createDataKey();
    const b = await crypto.createDataKey();

    expect(sameWrappedKey(a.envelope.wrappedKey, b.envelope.wrappedKey)).toBe(false);
  });

  it('handles different lengths without throwing', () => {
    // `timingSafeEqual` throws on a length mismatch, which would turn a
    // comparison into a crash.
    expect(sameWrappedKey('AAAA', 'AAAAAAAA')).toBe(false);
  });
});

/**
 * Corrupts one byte.
 *
 * `buffer[i] ^= 1` reads before it writes, and under `noUncheckedIndexedAccess`
 * that read is `number | undefined`. The typed accessors say what is meant
 * without an assertion that would quietly hide a genuine out-of-range mistake.
 */
function flip(buffer: Buffer, index: number): void {
  buffer.writeUInt8(buffer.readUInt8(index) ^ 0xff, index);
}

function attempt(work: () => unknown): string {
  try {
    work();
    return 'no error';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
