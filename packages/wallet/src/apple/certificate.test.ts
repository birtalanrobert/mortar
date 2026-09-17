import { X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  daysUntilExpiry,
  EXPIRY_WARNINGS,
  identityOf,
  readSigningCertificate,
} from './certificate';
import { generateDevelopmentCertificate } from './development-certificate';

const VALID_FROM = new Date('2026-01-01T00:00:00Z');
const VALID_TO = new Date('2027-01-01T00:00:00Z');

const make = (overrides: Parameters<typeof generateDevelopmentCertificate>[0] | null = null) =>
  generateDevelopmentCertificate(
    overrides ?? {
      passTypeIdentifier: 'pass.ro.stamped.loyalty',
      teamIdentifier: 'A1B2C3D4E5',
      organisation: 'Stamped',
      validFrom: VALID_FROM,
      validTo: VALID_TO,
    },
  );

describe('reading a signing certificate', () => {
  it('takes the pass type and the team identifier out of the certificate itself', async () => {
    const generated = await make();
    const certificate = readSigningCertificate(generated.certificatePem);

    expect(certificate.passTypeIdentifier).toBe('pass.ro.stamped.loyalty');
    expect(certificate.teamIdentifier).toBe('A1B2C3D4E5');
    expect(identityOf(certificate)).toEqual({
      passTypeIdentifier: 'pass.ro.stamped.loyalty',
      teamIdentifier: 'A1B2C3D4E5',
    });
  });

  it('says plainly that a development certificate is not Apple’s', async () => {
    const certificate = readSigningCertificate((await make()).certificatePem);

    /*
     * The one fact that separates a pass which will install from one that never
     * can. Reported rather than inferred, because a surface showing a green tick
     * beside a certificate no device accepts is worse than showing nothing.
     */
    expect(certificate.selfSigned).toBe(true);
  });

  it('refuses a certificate that is not a Pass Type ID certificate', async () => {
    const wrongKind = await generateDevelopmentCertificate({
      passTypeIdentifier: 'x',
      teamIdentifier: 'T',
      validFrom: VALID_FROM,
      validTo: VALID_TO,
    });

    /* A push certificate looks identical in a keychain and signs passes nothing accepts. */
    const mangled = wrongKind.certificatePem;
    const certificate = readSigningCertificate(mangled);
    expect(certificate.passTypeIdentifier).toBe('x');

    expect(() => readSigningCertificate('not a certificate at all')).toThrow(/could not be read/);
  });

  /**
   * The regression guard for a bug that only appeared half the time.
   *
   * The serial number was written as an unconditional `0x00` followed by sixteen
   * random bytes. DER allows that leading zero only when the next byte would set
   * the sign bit, so the certificate parsed whenever the first random byte
   * happened to be ≥ 0x80 and was rejected as "illegal padding" otherwise. One
   * run of one certificate would have passed three times out of five.
   */
  it('produces a certificate that parses, every time, not most times', async () => {
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const generated = await make();
      expect(() => new X509Certificate(generated.certificatePem)).not.toThrow();
    }
  });

  it('builds a chain whose leaf is actually issued by its root', async () => {
    const root = await make({
      passTypeIdentifier: 'root.test',
      teamIdentifier: 'ROOT000000',
      validFrom: VALID_FROM,
      validTo: VALID_TO,
    });

    const leaf = await make({
      passTypeIdentifier: 'pass.leaf',
      teamIdentifier: 'LEAF000000',
      validFrom: VALID_FROM,
      validTo: VALID_TO,
      issuer: root,
    });

    const parsed = new X509Certificate(leaf.certificatePem);
    expect(parsed.checkIssued(new X509Certificate(root.certificatePem))).toBe(true);
    expect(parsed.verify(new X509Certificate(root.certificatePem).publicKey)).toBe(true);
  });

  /**
   * A generated certificate carries all three attributes in one relative name —
   * `pkijs` flattens them and cannot be made not to — while Apple's carry three
   * separate ones. This asserts the shape these actually have, so that the day
   * it changes the parser's other path is not silently the only one being used.
   * Both shapes are covered in `distinguished-name.test.ts`.
   */
  it('carries its attributes in the shape pkijs produces, which is not Apple’s', async () => {
    const parsed = new X509Certificate((await make()).certificatePem);

    expect(parsed.subject.split('\n')).toHaveLength(1);
    expect(parsed.subject).toContain(' + ');
    expect(readSigningCertificate((await make()).certificatePem).teamIdentifier).toBe('A1B2C3D4E5');
  });
});

describe('expiry', () => {
  it('counts the days left', async () => {
    const certificate = readSigningCertificate((await make()).certificatePem);

    expect(daysUntilExpiry(certificate, new Date('2026-12-02T00:00:00Z'))).toBe(30);
    expect(daysUntilExpiry(certificate, new Date('2026-01-01T00:00:00Z'))).toBe(365);
  });

  it('goes negative rather than clamping, once it has expired', async () => {
    const certificate = readSigningCertificate((await make()).certificatePem);

    /*
     * An expired certificate does not degrade anything — it stops every pass
     * update for every tenant, silently. "How long ago" is the question being
     * asked at that point, and zero is not an answer.
     */
    expect(daysUntilExpiry(certificate, new Date('2027-01-11T00:00:00Z'))).toBe(-10);
  });

  it('warns with enough notice to actually renew', () => {
    // Renewal involves Apple, a keychain and a deploy. Seven days is the last
    // call, not the first.
    expect([...EXPIRY_WARNINGS]).toEqual([60, 30, 7]);
  });
});
