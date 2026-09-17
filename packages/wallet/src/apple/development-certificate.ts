import { generateKeyPairSync, randomBytes } from 'node:crypto';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';

/**
 * A Pass Type ID certificate that Apple did not issue.
 *
 * The one hard dependency of this whole package is an Apple Developer account,
 * and waiting for one would stop every other part of a product being built — so
 * this generates a certificate with the right shape and the wrong provenance.
 * Passes signed with it satisfy every structural and cryptographic rule the
 * conformance suite applies, and **no device will install one**.
 *
 * That combination is useful and dangerous in equal measure, so two things guard
 * it. {@link readSigningCertificate} reports `selfSigned`, and the surfaces that
 * show a certificate are expected to say so in words rather than showing a
 * green tick. And a real chain check — `verifyPkPass` with Apple's root as a
 * trust anchor — fails on one of these, which is the correct answer.
 *
 * It also removes openssl from the tests. A suite that shells out to a binary
 * is a suite whose failures depend on which machine it ran on.
 */

export interface DevelopmentCertificateInput {
  /** e.g. `pass.ro.stamped.loyalty`. Written into the common name. */
  passTypeIdentifier: string;
  /** The ten-character team identifier. Written into the organisational unit. */
  teamIdentifier: string;
  organisation?: string;
  validFrom: Date;
  validTo: Date;
  /**
   * Sign with this rather than with itself.
   *
   * Turns the result into a leaf of a chain, which is what the conformance tests
   * need in order to prove that chain checking actually rejects something.
   */
  issuer?: CertificateAndKey;
}

export interface CertificateAndKey {
  certificatePem: string;
  privateKeyPem: string;
}

/** OIDs for the attributes a Pass Type ID certificate carries. */
const OID = { commonName: '2.5.4.3', organisation: '2.5.4.10', organisationalUnit: '2.5.4.11' };

export async function generateDevelopmentCertificate(
  input: DevelopmentCertificateInput,
): Promise<CertificateAndKey> {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

  const certificate = new pkijs.Certificate();
  certificate.version = 2;
  certificate.serialNumber = new asn1js.Integer({ valueHex: serialNumber() });

  const subject = distinguishedName([
    { type: OID.commonName, value: `Pass Type ID: ${input.passTypeIdentifier}` },
    { type: OID.organisationalUnit, value: input.teamIdentifier },
    { type: OID.organisation, value: input.organisation ?? 'Development' },
  ]);

  certificate.subject = subject;

  const issuerCertificate = input.issuer
    ? pkijs.Certificate.fromBER(derOf(input.issuer.certificatePem))
    : undefined;

  /* Self-signed: the issuer is the subject, which is what makes it self-signed. */
  certificate.issuer = issuerCertificate ? issuerCertificate.subject : subject;

  certificate.notBefore.value = input.validFrom;
  certificate.notAfter.value = input.validTo;

  /*
   * Basic constraints, marked critical.
   *
   * Without it a path validator treats the certificate as unconstrained, and
   * pkijs's chain check refuses to build a path through a certificate that does
   * not say whether it may be an authority. A self-signed one signs itself and
   * so is its own CA; one with an issuer above it is a leaf and is not.
   */
  certificate.extensions = [
    new pkijs.Extension({
      extnID: '2.5.29.19',
      critical: true,
      extnValue: new pkijs.BasicConstraints({ cA: !issuerCertificate }).toSchema().toBER(false),
    }),
  ];

  await certificate.subjectPublicKeyInfo.importKey(
    await crypto.subtle.importKey(
      'spki',
      new Uint8Array(publicKey.export({ type: 'spki', format: 'der' })),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      true,
      ['verify'],
    ),
  );

  const signingKey = input.issuer
    ? pemToDer(input.issuer.privateKeyPem, 'PRIVATE KEY')
    : privateKey.export({ type: 'pkcs8', format: 'der' });

  await certificate.sign(
    await crypto.subtle.importKey(
      'pkcs8',
      new Uint8Array(signingKey),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    ),
    'SHA-256',
  );

  return {
    certificatePem: toPem(Buffer.from(certificate.toSchema(true).toBER(false)), 'CERTIFICATE'),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/**
 * The subject and issuer of a generated certificate.
 *
 * Built as one relative name per attribute, which is what a real certificate
 * looks like — and then flattened by `pkijs` on the way out into a single
 * multi-valued name, `CN=… + OU=… + O=…`, because its `toSchema` re-encodes a
 * parsed name from a flat list and has no way to express the grouping. That is
 * a cosmetic difference in a development fixture and not worth hand-encoding a
 * certificate to avoid, but it means the *shape* these produce is not the shape
 * Apple's have. `parseDistinguishedName` reads both, and is tested on both.
 */
function distinguishedName(
  attributes: readonly { type: string; value: string }[],
): pkijs.RelativeDistinguishedNames {
  return new pkijs.RelativeDistinguishedNames({
    schema: new asn1js.Sequence({
      value: attributes.map(
        (attribute) =>
          new asn1js.Set({
            value: [
              new pkijs.AttributeTypeAndValue({
                type: attribute.type,
                value: new asn1js.Utf8String({ value: attribute.value }),
              }).toSchema(),
            ],
          }),
      ),
    }),
  });
}

/**
 * A positive DER integer, minimally encoded.
 *
 * DER permits a leading zero byte **only** where the next byte would otherwise
 * set the sign bit, and forbids it everywhere else. Prefixing an unconditional
 * `0x00` therefore produced a certificate that parsed about half the time — the
 * half where the first random byte happened to be ≥ 0x80 — and "illegal padding"
 * from OpenSSL on the rest. Clearing the top bit removes the question.
 */
function serialNumber(): Buffer {
  const bytes = randomBytes(16);
  bytes[0] = (bytes[0]! & 0x7f) | 0x01;
  return bytes;
}

function toPem(der: Buffer, label: string): string {
  const body =
    der
      .toString('base64')
      .match(/.{1,64}/g)
      ?.join('\n') ?? '';
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

function pemToDer(pem: string, label: string): Buffer {
  const match = new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`).exec(pem);
  if (!match) throw new Error(`Expected a ${label} in PEM form.`);
  return Buffer.from(match[1]!.replace(/\s+/g, ''), 'base64');
}

const derOf = (pem: string): ArrayBuffer => {
  const der = pemToDer(pem, 'CERTIFICATE');
  return der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength) as ArrayBuffer;
};
