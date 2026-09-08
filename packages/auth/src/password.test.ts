import { describe, expect, it } from 'vitest';
import { MAX_PASSWORD_LENGTH, Pbkdf2Hasher, ScryptHasher } from './password';

// Deliberately weak parameters: these tests exercise behaviour, not cost, and
// production strength would make the suite unbearably slow.
const hasher = new ScryptHasher({ cost: 1024 });

describe('hash', () => {
  it('does not contain the password', async () => {
    expect(await hasher.hash('correct horse battery staple')).not.toContain('horse');
  });

  it('produces a different hash every time, because the salt is random', async () => {
    const a = await hasher.hash('same-password');
    const b = await hasher.hash('same-password');
    expect(a).not.toBe(b);
  });

  it('encodes its parameters, so they can be raised later', async () => {
    const encoded = await hasher.hash('x');
    expect(encoded.split('$').slice(0, 4)).toEqual(['scrypt', '1024', '8', '1']);
  });

  it('rejects an empty password', async () => {
    await expect(hasher.hash('')).rejects.toThrow();
  });

  it('rejects an absurdly long password, which is a denial-of-service vector', async () => {
    // Unbounded input into a deliberately expensive KDF costs the server real
    // work per attempt.
    await expect(hasher.hash('a'.repeat(MAX_PASSWORD_LENGTH + 1))).rejects.toThrow();
  });

  it('rejects a non-power-of-two cost at construction', () => {
    expect(() => new ScryptHasher({ cost: 1000 })).toThrow(/power of two/);
  });
});

describe('verify', () => {
  it('accepts the correct password', async () => {
    const encoded = await hasher.hash('s3cret!');
    expect(await hasher.verify('s3cret!', encoded)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const encoded = await hasher.hash('s3cret!');
    expect(await hasher.verify('s3cret?', encoded)).toBe(false);
  });

  it('is case-sensitive', async () => {
    const encoded = await hasher.hash('Password');
    expect(await hasher.verify('password', encoded)).toBe(false);
  });

  it('handles unicode consistently through normalisation', async () => {
    // The same character composed two ways must not lock a user out of their
    // own account depending on which keyboard they used.
    const composed = 'paßworté';
    const decomposed = 'paßworté';
    const encoded = await hasher.hash(composed);
    expect(await hasher.verify(decomposed, encoded)).toBe(true);
  });

  it('returns false rather than throwing on a malformed hash', async () => {
    for (const bad of [
      '',
      'nonsense',
      'scrypt$x$8$1$a$b',
      'bcrypt$1024$8$1$a$b',
      'scrypt$1024$8$1',
    ]) {
      expect(await hasher.verify('x', bad)).toBe(false);
    }
  });

  it('rejects a hash whose digest has been truncated', async () => {
    // scrypt is prefix-stable, so verifying at the stored digest's length
    // would let a truncated digest match — truncate to one byte and any
    // password succeeds about one time in 256. Short digests are refused.
    const encoded = await hasher.hash('x');
    const parts = encoded.split('$');
    for (const keep of [1, 4, 10, 40]) {
      parts[5] = Buffer.from(parts[5]!, 'base64').subarray(0, keep).toString('base64');
      expect(await hasher.verify('x', parts.join('$'))).toBe(false);
    }
  });

  it('rejects a hash whose salt has been truncated', async () => {
    const encoded = await hasher.hash('x');
    const parts = encoded.split('$');
    parts[4] = Buffer.from(parts[4]!, 'base64').subarray(0, 2).toString('base64');
    expect(await hasher.verify('x', parts.join('$'))).toBe(false);
  });
});

describe('needsRehash', () => {
  it('is true for a hash made with a lower cost', async () => {
    const weak = await new ScryptHasher({ cost: 512 }).hash('x');
    expect(new ScryptHasher({ cost: 1024 }).needsRehash(weak)).toBe(true);
  });

  it('is false at the current cost', async () => {
    expect(hasher.needsRehash(await hasher.hash('x'))).toBe(false);
  });

  it('is true for anything unparseable', () => {
    expect(hasher.needsRehash('garbage')).toBe(true);
  });

  it('lets an old password still verify against its own parameters', async () => {
    // Raising the cost must not lock every existing user out; old hashes
    // verify, then get rehashed on next successful login.
    const old = await new ScryptHasher({ cost: 512 }).hash('unchanged');
    expect(await new ScryptHasher({ cost: 1024 }).verify('unchanged', old)).toBe(true);
  });
});

/**
 * PBKDF2, for a secret a browser must also verify.
 *
 * Not a replacement for scrypt and not a general-purpose choice: it exists for
 * the one situation where a device has to check a credential with no network,
 * and the Web Crypto API implements PBKDF2 and does not implement scrypt.
 */
describe('Pbkdf2Hasher', () => {
  const hasher = new Pbkdf2Hasher({ iterations: 1000 });

  it('verifies what it hashed and nothing else', async () => {
    const encoded = await hasher.hash('4821');

    expect(await hasher.verify('4821', encoded)).toBe(true);
    expect(await hasher.verify('4822', encoded)).toBe(false);
  });

  it('carries its parameters, so they can be raised later', async () => {
    const encoded = await hasher.hash('4821');

    expect(encoded.startsWith('pbkdf2$sha256$1000$')).toBe(true);

    // An old hash verifies against its own parameters and is rehashed on the
    // next successful use — the same contract scrypt's has.
    expect(new Pbkdf2Hasher({ iterations: 600_000 }).needsRehash(encoded)).toBe(true);
    expect(hasher.needsRehash(encoded)).toBe(false);
  });

  it('salts, so two hashes of one PIN do not match', async () => {
    /*
     * Four digits is ten thousand possibilities. Without a per-secret salt a
     * single precomputed table covers every employee in every business at once
     * — and a rota kiosk holds a whole team's worth.
     */
    expect(await hasher.hash('4821')).not.toBe(await hasher.hash('4821'));
  });

  it('refuses a truncated digest rather than matching one in 256', async () => {
    /*
     * PBKDF2 is prefix-stable: the first N bytes of a long derivation equal the
     * whole of a short one. Verifying at the *stored* length would mean a
     * digest cut to one byte matches roughly one attempt in 256 — so a stored
     * length that is not plausible is refused outright.
     */
    const encoded = await hasher.hash('4821');
    const [, , iterations, salt, hash] = encoded.split('$');
    const truncated = Buffer.from(hash!, 'base64').subarray(0, 4).toString('base64');

    expect(
      await hasher.verify('4821', ['pbkdf2', 'sha256', iterations, salt, truncated].join('$')),
    ).toBe(false);
  });

  it('refuses anything that is not one of its own', async () => {
    const scrypted = await new ScryptHasher().hash('4821');

    // A hash in the other format must not silently pass or silently fail as
    // "wrong password": it is not a PBKDF2 hash and this says so.
    expect(await hasher.verify('4821', scrypted)).toBe(false);
    expect(hasher.needsRehash(scrypted)).toBe(true);
  });
});
