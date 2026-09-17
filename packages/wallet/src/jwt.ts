import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { ValidationError } from '@birtalanrobert/http';

/**
 * A JWT signer, in about forty lines, using `node:crypto` and nothing else.
 *
 * The repository's rule is to reach for a package before writing one, and the
 * obvious package here is `jose`. It is not used, for a reason that is about
 * this monorepo rather than about the library: `jose` is ESM-only, these
 * packages compile to CommonJS, and the workarounds — a dynamic import in a
 * synchronous path, or moving one package's module system — cost more than the
 * code they save.
 *
 * What is left is small because **nothing here verifies a token it did not
 * make**. Every dangerous part of JWT is on the verifying side: `alg: none`,
 * algorithm confusion, a key chosen by the header, an unvalidated `kid`. Two
 * tokens are produced — Google's save link and Apple's APNs authentication —
 * and both are read by somebody else. {@link verifyJwt} exists for the tests and
 * takes the algorithm as an argument rather than reading it from the header,
 * which is the one decision that makes the difference.
 *
 * The cryptography itself is Node's.
 */

export type JwtAlgorithm = 'RS256' | 'ES256';

export interface JwtHeader {
  alg: JwtAlgorithm;
  typ: 'JWT';
  /** Which key signed this, when the reader holds several. APNs requires it. */
  kid?: string;
}

const base64url = (input: Buffer | string): string => Buffer.from(input).toString('base64url');

/**
 * Signs a set of claims.
 *
 * `claims` is written as given: no `iat` is added, no `exp` is invented. A token
 * whose lifetime is decided somewhere other than the call site is a token nobody
 * can reason about, and both callers here have their own rules about it.
 */
export function signJwt(
  claims: Record<string, unknown>,
  key: KeyObject | Buffer | string,
  options: { algorithm: JwtAlgorithm; keyId?: string },
): string {
  const header: JwtHeader = {
    alg: options.algorithm,
    typ: 'JWT',
    ...(options.keyId ? { kid: options.keyId } : {}),
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const privateKey = typeof key === 'string' || Buffer.isBuffer(key) ? createPrivateKey(key) : key;

  if (options.algorithm === 'RS256' && privateKey.asymmetricKeyType !== 'rsa') {
    throw new ValidationError(
      [
        {
          field: 'key',
          message: `RS256 needs an RSA key; this one is ${privateKey.asymmetricKeyType ?? 'of an unknown type'}.`,
          code: 'key_algorithm_mismatch',
        },
      ],
      'That key cannot sign this token.',
    );
  }

  if (options.algorithm === 'ES256' && privateKey.asymmetricKeyType !== 'ec') {
    throw new ValidationError(
      [
        {
          field: 'key',
          message: `ES256 needs an elliptic-curve key; this one is ${privateKey.asymmetricKeyType ?? 'of an unknown type'}.`,
          code: 'key_algorithm_mismatch',
        },
      ],
      'That key cannot sign this token.',
    );
  }

  const signature =
    options.algorithm === 'RS256'
      ? sign('RSA-SHA256', Buffer.from(signingInput), privateKey)
      : /*
         * `ieee-p1363` is r‖s, which is what JOSE specifies. Node's default is
         * DER, and a DER signature in a JWT is accepted by nothing — it is the
         * single most common way a hand-rolled ES256 token fails, and it fails
         * at the far end where there is no log to read.
         */
        sign('sha256', Buffer.from(signingInput), { key: privateKey, dsaEncoding: 'ieee-p1363' });

  return `${signingInput}.${base64url(signature)}`;
}

export interface JwtParts {
  header: JwtHeader;
  claims: Record<string, unknown>;
}

/**
 * Checks a token against a key, with the algorithm supplied by the caller.
 *
 * **The algorithm is an argument and never read from the header.** That is the
 * whole of the defence: a verifier that trusts `alg` can be handed `none`, or an
 * HMAC token signed with the public key it was going to verify with.
 *
 * Returns `null` rather than throwing on a bad token, because the callers are
 * tests asserting a refusal.
 */
export function verifyJwt(
  token: string,
  key: KeyObject | Buffer | string,
  algorithm: JwtAlgorithm,
): JwtParts | null {
  const segments = token.split('.');
  if (segments.length !== 3) return null;

  const [encodedHeader, encodedClaims, encodedSignature] = segments as [string, string, string];
  const publicKey = typeof key === 'string' || Buffer.isBuffer(key) ? createPublicKey(key) : key;
  const signingInput = Buffer.from(`${encodedHeader}.${encodedClaims}`);
  const signature = Buffer.from(encodedSignature, 'base64url');

  const ok =
    algorithm === 'RS256'
      ? verify('RSA-SHA256', signingInput, publicKey, signature)
      : verify('sha256', signingInput, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature);

  if (!ok) return null;

  try {
    const header = JSON.parse(
      Buffer.from(encodedHeader, 'base64url').toString('utf8'),
    ) as JwtHeader;
    const claims = JSON.parse(Buffer.from(encodedClaims, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;

    /* A token signed with the right key but claiming another algorithm is not one we made. */
    return header.alg === algorithm ? { header, claims } : null;
  } catch {
    return null;
  }
}

/** The claims, without checking anything. For logs and for error messages only. */
export function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}
