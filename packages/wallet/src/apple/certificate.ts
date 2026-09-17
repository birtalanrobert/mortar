import { X509Certificate } from 'node:crypto';
import { ValidationError } from '@birtalanrobert/http';
import { parseDistinguishedName } from './distinguished-name';
import type { PassIdentity } from './pass-json';

/**
 * What a Pass Type ID certificate says about itself.
 *
 * Read rather than configured. The pass type identifier and the team identifier
 * must appear in `pass.json` *and* must match the certificate the file is signed
 * with, and a device refuses the pass when they disagree — with no message, and
 * across every tenant at once. Two configuration values that must equal two
 * fields of a certificate is a drift waiting to happen, so there is one source
 * and it is the certificate.
 */
export interface SigningCertificate {
  /** e.g. `pass.ro.stamped.loyalty`, taken from the common name. */
  passTypeIdentifier: string;
  /** The ten-character Apple team identifier, taken from the organisational unit. */
  teamIdentifier: string;
  subject: string;
  issuer: string;
  serialNumber: string;
  validFrom: Date;
  validTo: Date;
  /**
   * True when this certificate was not issued by Apple.
   *
   * A development certificate signs passes that satisfy every structural and
   * cryptographic rule in this package and that **no device will install**. That
   * is a useful thing to be able to do and a catastrophic thing to be confused
   * about, so it is a field rather than an inference, and the surfaces that show
   * a certificate are expected to say so in words.
   */
  selfSigned: boolean;
}

/** Apple's own name, as it appears in the issuer of a real Pass Type ID certificate. */
const APPLE_ISSUER = 'Apple Inc.';

const PASS_TYPE_PREFIX = 'Pass Type ID: ';

/**
 * Reads a PEM or DER certificate.
 *
 * Throws rather than returning problems: everything else in this package
 * collects, but there is no useful partial answer to "which certificate is
 * this" — and the caller is a startup path, where failing loudly is right.
 */
export function readSigningCertificate(pem: Buffer | string): SigningCertificate {
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(pem);
  } catch (cause) {
    throw new ValidationError(
      [
        {
          field: 'certificate',
          message: 'This is not a certificate that could be read.',
          code: 'unreadable_certificate',
        },
      ],
      'The signing certificate could not be read.',
      { cause },
    );
  }

  const subject = parseDistinguishedName(certificate.subject);
  const commonName = subject.get('CN') ?? '';
  const organisationalUnit = subject.get('OU') ?? '';

  if (!commonName.startsWith(PASS_TYPE_PREFIX)) {
    throw new ValidationError(
      [
        {
          field: 'certificate',
          /*
           * Named precisely because the mistake it catches is a common one: an
           * Apple Developer account holds several kinds of certificate and they
           * all look alike in a keychain. A push certificate here produces
           * passes that are signed, structurally perfect and universally
           * refused.
           */
          message: `Expected a Pass Type ID certificate, whose common name begins "${PASS_TYPE_PREFIX}". This one is "${commonName}".`,
          code: 'not_a_pass_type_certificate',
        },
      ],
      'That is not a Pass Type ID certificate.',
    );
  }

  return {
    passTypeIdentifier: commonName.slice(PASS_TYPE_PREFIX.length).trim(),
    teamIdentifier: organisationalUnit.trim(),
    subject: certificate.subject,
    issuer: certificate.issuer,
    serialNumber: certificate.serialNumber,
    validFrom: certificate.validFromDate,
    validTo: certificate.validToDate,
    selfSigned: !parseDistinguishedName(certificate.issuer).get('O')?.includes(APPLE_ISSUER),
  };
}

/** The identity written into `pass.json`, taken from the certificate that will sign it. */
export const identityOf = (certificate: SigningCertificate): PassIdentity => ({
  passTypeIdentifier: certificate.passTypeIdentifier,
  teamIdentifier: certificate.teamIdentifier,
});

/**
 * How many days until this certificate stops signing.
 *
 * Negative once it has expired, which is the case worth being able to say out
 * loud: an expired certificate does not degrade anything, it stops every pass
 * update for every tenant, and it does so silently.
 */
export function daysUntilExpiry(certificate: SigningCertificate, now: Date): number {
  const day = 24 * 60 * 60 * 1000;
  return Math.floor((certificate.validTo.getTime() - now.getTime()) / day);
}

/** The thresholds at which somebody is told. Renewal takes days, not minutes. */
export const EXPIRY_WARNINGS = [60, 30, 7] as const;
