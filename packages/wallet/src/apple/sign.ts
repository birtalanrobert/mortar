import { createHash, createPrivateKey, type KeyObject } from 'node:crypto';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { ValidationError } from '@birtalanrobert/http';

/**
 * The detached PKCS#7 signature over `manifest.json`.
 *
 * Built with `pkijs` rather than by hand, and this is the repository's own rule
 * applied: CMS is ASN.1, ASN.1 is a solved problem with decades behind it, and
 * the part that is actually ours is *which* bytes get signed and with what. The
 * alternative was shelling out to `openssl smime`, which makes the build depend
 * on a binary's version and its error messages.
 *
 * The output is cross-checked in the package's tests by `openssl smime -verify`,
 * which is the strongest evidence available without Apple: a signature two
 * independent implementations agree on is not a signature we talked ourselves
 * into.
 */

/** OIDs, named, because a bare number in a call is unreadable and unsearchable. */
const OID = {
  signedData: '1.2.840.113549.1.7.2',
  data: '1.2.840.113549.1.7.1',
  contentType: '1.2.840.113549.1.9.3',
  signingTime: '1.2.840.113549.1.9.5',
  messageDigest: '1.2.840.113549.1.9.4',
} as const;

export interface SigningMaterial {
  /** The Pass Type ID certificate, PEM or DER. */
  certificate: Buffer | string;
  /** Its private key, PEM or DER. */
  privateKey: Buffer | string;
  /** The passphrase, if the key is encrypted. */
  passphrase?: string;
  /**
   * Everything between the signing certificate and the root.
   *
   * For a real pass that is Apple's WWDR intermediate. The device already trusts
   * the root and will not fetch what it is not given, so omitting this produces
   * a signature that verifies in isolation and is refused on a phone — which is
   * exactly the class of failure this package exists to catch earlier.
   */
  intermediates?: readonly (Buffer | string)[];
}

export interface SignOptions {
  /**
   * The moment recorded in the signature.
   *
   * Injected rather than read from the clock so a build can be made
   * byte-reproducible — which is what lets the golden-file tests assert on a
   * whole archive instead of on the parts that happen to be stable.
   */
  signedAt?: Date;
}

/**
 * Signs `content`, returning a detached CMS SignedData in DER.
 *
 * Detached: the signature carries a digest of the content and not the content
 * itself, because the content is already in the archive as `manifest.json`.
 */
export async function signDetached(
  content: Uint8Array,
  material: SigningMaterial,
  options: SignOptions = {},
): Promise<Buffer> {
  const signer = parseCertificate(material.certificate, 'certificate');
  const chain = (material.intermediates ?? []).map((one, index) =>
    parseCertificate(one, `intermediates[${index}]`),
  );

  const key = privateKeyOf(material);
  const { webKey, hash } = await importForSigning(key);

  const signedAttributes = new pkijs.SignedAndUnsignedAttributes({
    type: 0,
    attributes: [
      new pkijs.Attribute({
        type: OID.contentType,
        values: [new asn1js.ObjectIdentifier({ value: OID.data })],
      }),
      new pkijs.Attribute({
        type: OID.signingTime,
        values: [new asn1js.UTCTime({ valueDate: options.signedAt ?? new Date() })],
      }),
      new pkijs.Attribute({
        type: OID.messageDigest,
        values: [
          new asn1js.OctetString({ valueHex: createHash('sha256').update(content).digest() }),
        ],
      }),
    ],
  });

  const signedData = new pkijs.SignedData({
    version: 1,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: OID.data }),
    signerInfos: [
      new pkijs.SignerInfo({
        version: 1,
        sid: new pkijs.IssuerAndSerialNumber({
          issuer: signer.issuer,
          serialNumber: signer.serialNumber,
        }),
        signedAttrs: signedAttributes,
      }),
    ],
    certificates: [signer, ...chain],
  });

  await signedData.sign(webKey, 0, hash);

  const envelope = new pkijs.ContentInfo({
    contentType: OID.signedData,
    content: signedData.toSchema(true),
  });

  return Buffer.from(envelope.toSchema().toBER(false));
}

export interface SignatureVerdict {
  verified: boolean;
  /** Why not, in words, when it did not verify. */
  reason?: string;
  /** The certificate that signed it, as a subject line. */
  signer?: string;
}

/**
 * Verifies a detached signature over `content`, optionally against a trust anchor.
 *
 * Two questions, and they are separate. Without `trustedRoots` this answers only
 * "were these bytes signed by the key in this container" — which is what a test
 * with a generated certificate wants. With them it also answers "does that key
 * chain to somebody we trust", which is the question a real pass has to pass and
 * the one a self-signed certificate fails.
 */
export async function verifyDetached(
  signature: Uint8Array,
  content: Uint8Array,
  trustedRoots: readonly (Buffer | string)[] = [],
): Promise<SignatureVerdict> {
  let signedData: pkijs.SignedData;
  try {
    const envelope = pkijs.ContentInfo.fromBER(toArrayBuffer(signature));
    signedData = new pkijs.SignedData({ schema: envelope.content });
  } catch (cause) {
    return { verified: false, reason: `The signature is not a CMS SignedData: ${message(cause)}` };
  }

  const anchors = trustedRoots.map((one, index) => parseCertificate(one, `trustedRoots[${index}]`));

  try {
    const outcome = await signedData.verify({
      signer: 0,
      data: toArrayBuffer(content),
      ...(anchors.length ? { trustedCerts: anchors, checkChain: true } : {}),
      extendedMode: true,
    });

    const subject = signedData.certificates?.[0];
    const signer =
      subject instanceof pkijs.Certificate
        ? subject.subject.typesAndValues.map((one) => String(one.value.valueBlock.value)).join(', ')
        : undefined;

    return outcome.signatureVerified
      ? { verified: true, ...(signer ? { signer } : {}) }
      : { verified: false, reason: outcome.message || 'The signature did not verify.' };
  } catch (cause) {
    /*
     * pkijs throws rather than returning false when the *chain* fails, which is
     * a different answer from a bad signature and is reported as one.
     */
    return { verified: false, reason: message(cause) };
  }
}

function parseCertificate(source: Buffer | string, field: string): pkijs.Certificate {
  try {
    return pkijs.Certificate.fromBER(toArrayBuffer(derOf(source)));
  } catch (cause) {
    throw new ValidationError(
      [
        {
          field,
          message: `Could not read a certificate: ${message(cause)}`,
          code: 'bad_certificate',
        },
      ],
      'A certificate could not be read.',
      { cause },
    );
  }
}

/** PEM in, DER out; DER in, DER out. */
function derOf(source: Buffer | string): Buffer {
  const text = typeof source === 'string' ? source : source.toString('latin1');
  const pem = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/.exec(text);
  if (!pem) return typeof source === 'string' ? Buffer.from(source, 'binary') : source;
  return Buffer.from(pem[1]!.replace(/\s+/g, ''), 'base64');
}

function privateKeyOf(material: SigningMaterial): KeyObject {
  try {
    return createPrivateKey(
      material.passphrase
        ? { key: material.privateKey, passphrase: material.passphrase }
        : material.privateKey,
    );
  } catch (cause) {
    throw new ValidationError(
      [
        {
          field: 'privateKey',
          /* The overwhelmingly common cause, named so nobody re-derives it. */
          message: material.passphrase
            ? 'The private key could not be read. The passphrase may be wrong.'
            : 'The private key could not be read. If it is encrypted, supply its passphrase.',
          code: 'unreadable_private_key',
        },
      ],
      'The signing key could not be read.',
      { cause },
    );
  }
}

/**
 * Hands the key to WebCrypto, which is what pkijs signs with.
 *
 * The algorithm comes from the key rather than from configuration: an RSA key
 * and an EC key need different parameters, and asking the caller which they have
 * is asking them to get it wrong.
 */
async function importForSigning(key: KeyObject): Promise<{ webKey: CryptoKey; hash: string }> {
  /* A fresh view over a plain ArrayBuffer: WebCrypto's types exclude Node's Buffer. */
  const pkcs8 = new Uint8Array(key.export({ type: 'pkcs8', format: 'der' }));

  if (key.asymmetricKeyType === 'rsa') {
    return {
      webKey: await crypto.subtle.importKey(
        'pkcs8',
        pkcs8,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['sign'],
      ),
      hash: 'SHA-256',
    };
  }

  if (key.asymmetricKeyType === 'ec') {
    const curve = key.asymmetricKeyDetails?.namedCurve ?? 'prime256v1';
    const named = curve === 'secp384r1' ? 'P-384' : curve === 'secp521r1' ? 'P-521' : 'P-256';
    return {
      webKey: await crypto.subtle.importKey(
        'pkcs8',
        pkcs8,
        { name: 'ECDSA', namedCurve: named },
        false,
        ['sign'],
      ),
      hash: named === 'P-384' ? 'SHA-384' : named === 'P-521' ? 'SHA-512' : 'SHA-256',
    };
  }

  throw new ValidationError(
    [
      {
        field: 'privateKey',
        message: `A ${key.asymmetricKeyType ?? 'key of this kind'} cannot sign a pass. Apple issues RSA Pass Type ID certificates.`,
        code: 'unsupported_key_type',
      },
    ],
    'That key cannot sign a pass.',
  );
}

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
