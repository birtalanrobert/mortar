import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeJwtClaims, signJwt, verifyJwt } from './jwt';

/** The first field error a call throws, which is where the useful sentence is. */
function fieldMessage(call: () => unknown): string {
  try {
    call();
  } catch (error) {
    return (error as { errors?: { message: string }[] }).errors?.[0]?.message ?? '';
  }
  throw new Error('Expected that call to throw.');
}

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

describe('signing', () => {
  it('produces three segments a reader can verify', () => {
    const token = signJwt({ iss: 'a@b.iam.gserviceaccount.com', aud: 'google' }, rsa.privateKey, {
      algorithm: 'RS256',
    });

    expect(token.split('.')).toHaveLength(3);
    expect(verifyJwt(token, rsa.publicKey, 'RS256')?.claims).toEqual({
      iss: 'a@b.iam.gserviceaccount.com',
      aud: 'google',
    });
  });

  it('writes the key identifier when there is one, which APNs requires', () => {
    const token = signJwt({ iss: 'TEAM123456' }, ec.privateKey, {
      algorithm: 'ES256',
      keyId: 'ABCD123456',
    });

    expect(verifyJwt(token, ec.publicKey, 'ES256')?.header).toEqual({
      alg: 'ES256',
      typ: 'JWT',
      kid: 'ABCD123456',
    });
  });

  /**
   * The mistake this exists to prevent.
   *
   * Node signs ECDSA as DER by default; JOSE specifies the raw r‖s pair. A DER
   * signature in a JWT is accepted by nothing, and it fails at the far end —
   * inside Apple — where there is no log to read.
   */
  it('writes an ES256 signature in the size JOSE specifies', () => {
    const token = signJwt({ iss: 'x' }, ec.privateKey, { algorithm: 'ES256' });
    const signature = Buffer.from(token.split('.')[2]!, 'base64url');

    expect(signature).toHaveLength(64);
  });

  it('adds nothing of its own to the claims', () => {
    // No invented `iat`, no invented `exp`: both callers have their own rules
    // about lifetime, and a token whose lifetime is decided elsewhere is one
    // nobody can reason about.
    const token = signJwt({ iss: 'x' }, rsa.privateKey, { algorithm: 'RS256' });

    expect(Object.keys(decodeJwtClaims(token) ?? {})).toEqual(['iss']);
  });

  it('refuses a key that cannot do the algorithm asked for', () => {
    /*
     * The field error rather than the message: a `ValidationError`'s message is
     * the sentence shown to a person, and the sentence a developer needs — which
     * key, and why — is in `errors`.
     */
    expect(() => signJwt({}, ec.privateKey, { algorithm: 'RS256' })).toThrow(
      /cannot sign this token/,
    );
    expect(fieldMessage(() => signJwt({}, ec.privateKey, { algorithm: 'RS256' }))).toMatch(
      /RS256 needs an RSA key/,
    );
    expect(fieldMessage(() => signJwt({}, rsa.privateKey, { algorithm: 'ES256' }))).toMatch(
      /ES256 needs an elliptic-curve key/,
    );
  });
});

describe('verifying', () => {
  it('refuses a token signed by somebody else', () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const token = signJwt({ iss: 'x' }, other.privateKey, { algorithm: 'RS256' });

    expect(verifyJwt(token, rsa.publicKey, 'RS256')).toBeNull();
  });

  it('refuses a token whose claims were edited', () => {
    const token = signJwt({ iss: 'x', amount: 1 }, rsa.privateKey, { algorithm: 'RS256' });
    const [header, , signature] = token.split('.');
    const edited = Buffer.from(JSON.stringify({ iss: 'x', amount: 1000 })).toString('base64url');

    expect(verifyJwt(`${header}.${edited}.${signature}`, rsa.publicKey, 'RS256')).toBeNull();
  });

  /**
   * The whole reason the algorithm is an argument rather than read from the
   * header: a verifier that trusts `alg` can be handed `none`.
   */
  it('refuses a token that claims to need no signature at all', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ iss: 'attacker' })).toString('base64url');

    expect(verifyJwt(`${header}.${claims}.`, rsa.publicKey, 'RS256')).toBeNull();
  });

  it('refuses a correctly signed token that lies about its algorithm', () => {
    const token = signJwt({ iss: 'x' }, rsa.privateKey, { algorithm: 'RS256' });
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT' })).toString('base64url');

    expect(
      verifyJwt(`${header}.${token.split('.')[1]}.${token.split('.')[2]}`, rsa.publicKey, 'RS256'),
    ).toBeNull();
  });

  it('refuses something that is not a token', () => {
    expect(verifyJwt('nonsense', rsa.publicKey, 'RS256')).toBeNull();
    expect(decodeJwtClaims('nonsense')).toBeNull();
  });
});
