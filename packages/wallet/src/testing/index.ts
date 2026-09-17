/**
 * Fixtures for testing against real passes.
 *
 * Published rather than kept to this package's own tests, because every product
 * that issues a pass has to test that it issued the right one — and the
 * alternative is each of them inventing a certificate, a chain and a set of
 * correctly sized images, differently, and getting one of the three subtly
 * wrong.
 *
 * Nothing here touches a network, a keychain or a file. A suite using it needs
 * no Apple account, no openssl binary, and no fixture directory.
 */

import {
  generateDevelopmentCertificate,
  type CertificateAndKey,
} from '../apple/development-certificate';
import type { SigningMaterial } from '../apple/sign';
import type { PassAssets, PassContent } from '../content';
import { solidPng } from '../images/placeholder';

export { solidPng, fingerprint } from '../images/placeholder';

/** Images at the sizes the layout expects, with correct densities. */
export function sampleAssets(): PassAssets {
  return {
    icon: { x1: solidPng(29, 29), x2: solidPng(58, 58), x3: solidPng(87, 87) },
    logo: { x1: solidPng(160, 50), x2: solidPng(320, 100) },
    strip: { x1: solidPng(375, 123), x2: solidPng(750, 246) },
  };
}

export interface TestSigner {
  material: SigningMaterial;
  /** The root the signing certificate chains to. Passed to `verifyPkPass`. */
  trustedRoots: string[];
  /** The root and the leaf, for a test that needs to look at them. */
  root: CertificateAndKey;
  leaf: CertificateAndKey;
}

/**
 * A two-certificate chain: a root, and a Pass Type ID certificate under it.
 *
 * A chain rather than a single self-signed certificate on purpose. A self-signed
 * one verifies against itself, which makes every chain assertion in a suite pass
 * for the wrong reason — including the one that is supposed to prove a stranger's
 * certificate is rejected.
 */
export async function testSigner(
  options: {
    passTypeIdentifier?: string;
    teamIdentifier?: string;
    validFrom?: Date;
    validTo?: Date;
  } = {},
): Promise<TestSigner> {
  const validFrom = options.validFrom ?? new Date('2026-01-01T00:00:00Z');
  const validTo = options.validTo ?? new Date('2027-01-01T00:00:00Z');

  const root = await generateDevelopmentCertificate({
    passTypeIdentifier: 'root.test',
    teamIdentifier: 'TESTROOT01',
    organisation: 'Mortar Test Root',
    validFrom,
    validTo,
  });

  const leaf = await generateDevelopmentCertificate({
    passTypeIdentifier: options.passTypeIdentifier ?? 'pass.test.loyalty',
    teamIdentifier: options.teamIdentifier ?? 'TEAM123456',
    organisation: 'Mortar Test',
    validFrom,
    validTo,
    issuer: root,
  });

  return {
    material: {
      certificate: leaf.certificatePem,
      privateKey: leaf.privateKeyPem,
      intermediates: [],
    },
    trustedRoots: [root.certificatePem],
    root,
    leaf,
  };
}

/**
 * A plausible stamp card.
 *
 * Plausible rather than minimal: it carries a barcode, a location, an update web
 * service and per-locale text, because a fixture that omits them is a fixture
 * whose tests never touch the parts most likely to be wrong.
 */
export function sampleContent(overrides: Partial<PassContent> = {}): PassContent {
  return {
    style: 'storeCard',
    serialNumber: '0f9d4b7a-3c21-4f7e-9c2a-8d5e6f1b2c3d',
    organizationName: 'Cafeneaua Verde',
    description: 'Card de fidelitate — Cafeneaua Verde',
    logoText: 'Cafeneaua Verde',
    colours: {
      background: { r: 24, g: 58, b: 44 },
      foreground: { r: 255, g: 255, b: 255 },
      label: { r: 198, g: 220, b: 210 },
    },
    assets: sampleAssets(),
    header: [{ key: 'balance', label: 'Ștampile', value: '7 / 10' }],
    primary: [
      {
        key: 'reward',
        label: 'Recompensă',
        value: 'A 10-a cafea gratuită',
        changeMessage: 'Ai acum %@',
      },
    ],
    secondary: [{ key: 'member', label: 'Membru', value: 'Ana Popescu' }],
    back: [
      { key: 'terms', label: 'Termeni', value: 'Ștampilele nu expiră.' },
      { key: 'unsubscribe', label: 'Dezabonare', value: 'https://stamped.example/u/abc' },
    ],
    barcode: { format: 'qr', message: 'STMP-0F9D4B7A', altText: 'STMP-0F9D4B7A' },
    locations: [{ latitude: 46.7712, longitude: 23.6236, relevantText: 'Cafeneaua Verde' }],
    maxDistance: 150,
    webService: {
      url: 'https://api.stamped.example/wallet',
      authenticationToken: 'b7f3a1c9d5e28046aa31c7be',
    },
    localisations: {
      ro: { Ștampile: 'Ștampile', Recompensă: 'Recompensă' },
      en: { Ștampile: 'Stamps', Recompensă: 'Reward' },
    },
    holder: { name: 'Ana Popescu', accountId: 'cus_7f2a' },
    ...overrides,
  };
}
