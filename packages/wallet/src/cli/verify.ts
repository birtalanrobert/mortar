#!/usr/bin/env node
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildPkPass } from '../apple/build';
import { daysUntilExpiry, readSigningCertificate } from '../apple/certificate';
import { generateDevelopmentCertificate } from '../apple/development-certificate';
import { RULES, RULES_REVIEWED } from '../apple/rules';
import { verifyPkPass } from '../apple/verify';
import { buildLoyaltyClass, buildLoyaltyObject } from '../google/payload';
import { buildSaveToken } from '../google/save-link';
import { verifyJwt } from '../jwt';
import { sampleContent } from '../testing';

/**
 * `wallet:verify` — the answer to "is the wallet layer actually working".
 *
 * Two modes, and the difference between them is the whole point.
 *
 * **Without credentials** it generates a development certificate, builds a pass
 * with it and checks the result against every rule. That proves the pipeline —
 * manifest, signature, `pass.json`, images, the Google payloads and the save
 * token — and it proves nothing about Apple, which is stated in the report
 * rather than left to be assumed.
 *
 * **With `--live`** it uses the real signing material and checks it against a
 * real trust anchor, which is the only thing that can tell anybody whether the
 * certificate in configuration is one Apple issued. What it cannot do yet is
 * call APNs or Google's object API — those clients land with the update web
 * service — and it says so by name rather than quietly passing.
 *
 * Nothing here prints a key, a token or a passphrase.
 */

interface Options {
  live: boolean;
  certificate?: string;
  key?: string;
  passphrase?: string;
  wwdr?: string;
  root?: string;
}

function parse(argv: string[]): Options {
  const options: Options = { live: argv.includes('--live') };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || !value || value.startsWith('--')) continue;

    if (flag === '--certificate') options.certificate = value;
    if (flag === '--key') options.key = value;
    if (flag === '--wwdr') options.wwdr = value;
    if (flag === '--root') options.root = value;
  }

  options.certificate ??= process.env.WALLET_APPLE_CERTIFICATE;
  options.key ??= process.env.WALLET_APPLE_KEY;
  options.wwdr ??= process.env.WALLET_APPLE_WWDR;
  options.root ??= process.env.WALLET_APPLE_ROOT;
  options.passphrase = process.env.WALLET_APPLE_PASSPHRASE;

  return options;
}

/** A PEM, whether the setting holds the text or the path to a file holding it. */
const pem = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  if (value.includes('-----BEGIN')) return value;
  return readFileSync(value, 'utf8');
};

const tick = (ok: boolean) => (ok ? '  ok  ' : ' FAIL ');

async function main(): Promise<number> {
  const options = parse(process.argv.slice(2));
  const lines: string[] = [];
  let failures = 0;

  const report = (ok: boolean, what: string, detail = '') => {
    if (!ok) failures += 1;
    lines.push(`[${tick(ok)}] ${what}${detail ? ` — ${detail}` : ''}`);
  };

  lines.push(`Wallet conformance — rules last reviewed ${RULES_REVIEWED}`);
  lines.push(`${Object.keys(RULES).length} rules, each with a citation in apple/rules.ts`);
  lines.push('');

  /* --- Apple --- */

  const supplied = pem(options.certificate);
  const validFrom = new Date(Date.now() - 60_000);
  const validTo = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

  let material;
  let trustedRoots: string[];

  if (supplied) {
    material = {
      certificate: supplied,
      privateKey: pem(options.key) ?? '',
      ...(options.passphrase ? { passphrase: options.passphrase } : {}),
      intermediates: [pem(options.wwdr)].filter((one): one is string => Boolean(one)),
    };
    const root = pem(options.root);
    trustedRoots = root ? [root] : [];
  } else {
    if (options.live) {
      report(
        false,
        'live mode needs a certificate',
        'pass --certificate and --key, or set WALLET_APPLE_CERTIFICATE',
      );
      lines.push('');
      process.stdout.write(lines.join('\n') + '\n');
      return 1;
    }

    const root = await generateDevelopmentCertificate({
      passTypeIdentifier: 'development.root',
      teamIdentifier: 'DEVROOT001',
      validFrom,
      validTo,
    });
    const leaf = await generateDevelopmentCertificate({
      passTypeIdentifier: 'pass.development.sample',
      teamIdentifier: 'DEV1234567',
      validFrom,
      validTo,
      issuer: root,
    });

    material = { certificate: leaf.certificatePem, privateKey: leaf.privateKeyPem };
    trustedRoots = [root.certificatePem];
  }

  const certificate = readSigningCertificate(material.certificate);
  const daysLeft = daysUntilExpiry(certificate, new Date());

  lines.push(`Certificate  ${certificate.passTypeIdentifier} / team ${certificate.teamIdentifier}`);
  lines.push(`             issued by ${certificate.issuer.split('\n').join(', ')}`);
  lines.push(
    `             expires ${certificate.validTo.toISOString().slice(0, 10)} (${daysLeft} days)`,
  );
  lines.push('');

  report(
    daysLeft > 0,
    'the certificate has not expired',
    daysLeft > 0 ? '' : 'every pass update stops while it is expired',
  );

  if (certificate.selfSigned) {
    report(
      !options.live,
      'the certificate is a development one',
      options.live
        ? 'live mode was asked for and this certificate was not issued by Apple'
        : 'passes will validate here and will not install on any device',
    );
  }

  const pass = await buildPkPass(sampleContent(), material, { builtAt: new Date('2026-01-01') });
  const verdict = await verifyPkPass(pass.bytes, { trustedRoots });

  report(verdict.problems.length === 0, 'the pass satisfies every rule');
  for (const problem of verdict.problems)
    lines.push(`         ${problem.path}: ${problem.message}`);

  report(verdict.signature.verified, 'the signature verifies', verdict.signature.reason ?? '');
  report(
    verdict.signature.chainChecked,
    'the signing certificate chains to a trust anchor',
    verdict.signature.chainChecked
      ? ''
      : 'no root supplied, so only the signature itself was checked',
  );

  /* --- Google --- */

  const suppliedGoogleKey = pem(process.env.WALLET_GOOGLE_PRIVATE_KEY);
  const suppliedGoogleEmail = process.env.WALLET_GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const issuerId = process.env.WALLET_GOOGLE_ISSUER_ID ?? '3388000000000000000';

  lines.push('');

  if (options.live && !(suppliedGoogleKey && suppliedGoogleEmail)) {
    report(
      false,
      'Google credentials are configured',
      'live mode needs WALLET_GOOGLE_SERVICE_ACCOUNT_EMAIL and WALLET_GOOGLE_PRIVATE_KEY',
    );
  } else {
    /*
     * With no service account, a key generated here signs the token instead —
     * the same trade the development certificate makes. It proves the token is
     * built and signed correctly, which is a real thing to know, and the line
     * says which key it used so nobody reads it as a live check.
     */
    const generated = !(suppliedGoogleKey && suppliedGoogleEmail);
    const googleKey =
      suppliedGoogleKey ??
      generateKeyPairSync('rsa', { modulusLength: 2048 })
        .privateKey.export({ type: 'pkcs8', format: 'pem' })
        .toString();
    const googleEmail = suppliedGoogleEmail ?? 'development@example.com';

    const token = buildSaveToken({
      serviceAccountEmail: googleEmail,
      privateKey: googleKey,
      origins: ['https://example.com'],
      loyaltyObject: buildLoyaltyObject(sampleContent(), {
        issuerId,
        classSuffix: 'verify',
        objectSuffix: 'verify-1',
        now: new Date(),
      }),
      loyaltyClass: buildLoyaltyClass(sampleContent(), {
        issuerId,
        issuerName: 'Verification',
        classSuffix: 'verify',
        programName: 'Verification',
      }),
      now: new Date(),
    });

    /*
     * Verified with the public half of the same key — which is what Google does
     * with the service account's published key. It proves the token is
     * well-formed and correctly signed, not that Google accepts the account.
     */
    report(
      verifyJwt(token, googleKey, 'RS256') !== null,
      'the Google save token signs and verifies',
      generated ? 'signed with a key generated for this run, not a service account' : '',
    );
  }

  if (options.live) {
    lines.push('');
    lines.push('Not checked, and not silently passed:');
    /*
     * Named individually. A live run that printed nothing about these would read
     * as a clean bill of health for three things it never looked at.
     */
    lines.push('  · APNs delivery — the client arrives with the update web service');
    lines.push('  · Google object API writes — likewise');
    lines.push('  · that a device renders the pass as intended — no device, by design');
  }

  lines.push('');
  lines.push(failures === 0 ? 'Everything checkable here passed.' : `${failures} check(s) failed.`);

  process.stdout.write(lines.join('\n') + '\n');
  return failures === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
