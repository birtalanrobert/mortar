import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createZip, readZip } from '@birtalanrobert/files/zip';
import { beforeAll, describe, expect, it } from 'vitest';
import { sampleContent, solidPng, testSigner, type TestSigner } from '../testing';
import { buildPkPass } from './build';
import { verifyPkPass } from './verify';

/**
 * The conformance suite: what stands in for a phone.
 *
 * There is no iPhone in this programme and there will not be one, so the
 * evidence that a pass is correct has to come from the file itself. This suite
 * builds real passes and then takes them apart the way a device would: it reads
 * the archive back from its bytes, re-derives every hash, verifies the signature
 * cryptographically against a chain, and checks `pass.json` against the rules.
 *
 * Two of these assertions are worth more than the rest, because they are the
 * only ones that are not this package marking its own homework — `openssl`
 * agreeing that the signature is valid, and the chain check rejecting a
 * certificate from somebody else.
 *
 * What none of it proves is that a lock screen renders the result, that APNs
 * delivers, or that Apple accepts our certificate. Those are named in the
 * product plan as unprovable here rather than quietly implied by a green run.
 */

const BUILT_AT = new Date('2026-06-01T09:00:00Z');

describe('a signed pass', () => {
  let signer: TestSigner;

  beforeAll(async () => {
    signer = await testSigner();
  });

  it('carries exactly the files Apple looks for', async () => {
    const pass = await buildPkPass(sampleContent(), signer.material, { builtAt: BUILT_AT });
    const files = readZip(pass.bytes);

    expect([...files.keys()].sort()).toEqual([
      'en.lproj/pass.strings',
      'icon.png',
      'icon@2x.png',
      'icon@3x.png',
      'logo.png',
      'logo@2x.png',
      'manifest.json',
      'pass.json',
      'ro.lproj/pass.strings',
      'signature',
      'strip.png',
      'strip@2x.png',
    ]);
  });

  it('takes its identity from the certificate rather than from configuration', async () => {
    const pass = await buildPkPass(sampleContent(), signer.material, { builtAt: BUILT_AT });

    /*
     * The pair a device compares against the signature. Configured separately
     * they drift, and the drift is invisible until every pass across every
     * tenant is refused with no message.
     */
    expect(pass.passJson.passTypeIdentifier).toBe('pass.test.loyalty');
    expect(pass.passJson.teamIdentifier).toBe('TEAM123456');
  });

  it('hashes every file in the archive, and hashes nothing else', async () => {
    const pass = await buildPkPass(sampleContent(), signer.material, { builtAt: BUILT_AT });
    const files = readZip(pass.bytes);
    const manifest = JSON.parse(files.get('manifest.json')!.toString('utf8')) as Record<
      string,
      string
    >;

    const hashed = [...files.keys()].filter(
      (name) => name !== 'manifest.json' && name !== 'signature',
    );

    expect(Object.keys(manifest).sort()).toEqual(hashed.sort());

    for (const [name, digest] of Object.entries(manifest)) {
      expect(createHash('sha1').update(files.get(name)!).digest('hex')).toBe(digest);
    }
  });

  it('verifies, and openssl agrees that it does', async () => {
    const pass = await buildPkPass(sampleContent(), signer.material, { builtAt: BUILT_AT });

    const verdict = await verifyPkPass(pass.bytes, { trustedRoots: signer.trustedRoots });
    expect(verdict.problems).toEqual([]);
    expect(verdict.valid).toBe(true);
    expect(verdict.signature).toMatchObject({ verified: true, chainChecked: true });

    /*
     * The one assertion in this file written by other people. A detached CMS
     * signature that two independent implementations accept is not a signature
     * we talked ourselves into.
     */
    const directory = mkdtempSync(join(tmpdir(), 'mortar-pass-'));
    const files = readZip(pass.bytes);
    writeFileSync(join(directory, 'manifest.json'), files.get('manifest.json')!);
    writeFileSync(join(directory, 'signature'), files.get('signature')!);
    writeFileSync(join(directory, 'root.pem'), signer.trustedRoots[0]!);

    const output = execFileSync(
      'openssl',
      [
        'smime',
        '-verify',
        '-inform',
        'DER',
        '-in',
        'signature',
        '-content',
        'manifest.json',
        '-CAfile',
        'root.pem',
        '-purpose',
        'any',
        '-out',
        '/dev/null',
      ],
      { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );

    expect(String(output)).toBeDefined();
  });

  it('produces the same bytes twice from the same content', async () => {
    const first = await buildPkPass(sampleContent(), signer.material, { builtAt: BUILT_AT });
    const second = await buildPkPass(sampleContent(), signer.material, { builtAt: BUILT_AT });

    /*
     * Not tidiness. The manifest hashes the content, so a build that varies
     * makes every rebuild look to a device like a change — and turns "did this
     * pass change" into a question with no answer.
     */
    expect(first.manifest).toEqual(second.manifest);
    expect(first.bytes.equals(second.bytes)).toBe(true);
  });

  it('writes per-locale text where the device looks for it', async () => {
    const pass = await buildPkPass(sampleContent(), signer.material, { builtAt: BUILT_AT });
    const strings = readZip(pass.bytes).get('ro.lproj/pass.strings')!.toString('utf8');

    expect(strings).toContain('"Ștampile" = "Ștampile";');
    expect(readZip(pass.bytes).get('en.lproj/pass.strings')!.toString('utf8')).toContain(
      '"Ștampile" = "Stamps";',
    );
  });

  it('escapes a quotation mark in a business name rather than truncating the file', async () => {
    const pass = await buildPkPass(
      sampleContent({ localisations: { en: { shop: 'Joe\'s "Best" Coffee' } } }),
      signer.material,
      { builtAt: BUILT_AT },
    );

    // Unescaped, the second quotation mark ends the string and takes the rest
    // of the file with it — including every line after it.
    expect(readZip(pass.bytes).get('en.lproj/pass.strings')!.toString('utf8')).toBe(
      '"shop" = "Joe\'s \\"Best\\" Coffee";\n',
    );
  });
});

describe('what the checker catches', () => {
  let signer: TestSigner;

  beforeAll(async () => {
    signer = await testSigner();
  });

  /** Rebuilds an archive with one file changed or added, leaving everything else alone. */
  const rebuild = (bytes: Buffer, changes: Record<string, Buffer | null>): Buffer => {
    const files = readZip(bytes);
    for (const [path, content] of Object.entries(changes)) {
      if (content === null) files.delete(path);
      else files.set(path, content);
    }
    return createZip(
      [...files.entries()].map(([path, content]) => ({ path, content })),
      { modified: BUILT_AT },
    );
  };

  it('catches a pass.json edited after signing', async () => {
    const pass = await buildPkPass(sampleContent(), signer.material, { builtAt: BUILT_AT });

    const tampered = rebuild(pass.bytes, {
      'pass.json': Buffer.from(
        JSON.stringify({ ...pass.passJson, organizationName: 'Somebody Else' }),
      ),
    });

    const verdict = await verifyPkPass(tampered, { trustedRoots: signer.trustedRoots });

    expect(verdict.valid).toBe(false);
    expect(verdict.problems.map((one) => one.rule)).toContain('manifestCoversArchive');
    expect(verdict.problems.find((one) => one.path === 'pass.json')?.message).toMatch(
      /hashes to .*the manifest says/,
    );
  });

  /**
   * The direction that gets forgotten.
   *
   * A checker that walks the manifest and stops sees nothing wrong here: every
   * entry it knows about is correct. The extra file is refused by the device
   * with a message that names nothing useful.
   */
  it('catches a file added to the archive that the manifest does not cover', async () => {
    const pass = await buildPkPass(sampleContent(), signer.material, { builtAt: BUILT_AT });
    const smuggled = rebuild(pass.bytes, { 'extra.png': solidPng(10, 10) });

    const verdict = await verifyPkPass(smuggled, { trustedRoots: signer.trustedRoots });

    expect(verdict.valid).toBe(false);
    expect(verdict.problems).toContainEqual(
      expect.objectContaining({ rule: 'manifestCoversArchive', path: 'extra.png' }),
    );
  });

  it('catches a signature lifted from another pass', async () => {
    const mine = await buildPkPass(sampleContent(), signer.material, { builtAt: BUILT_AT });
    const other = await buildPkPass(
      sampleContent({ serialNumber: 'another-serial' }),
      signer.material,
      { builtAt: BUILT_AT },
    );

    const swapped = rebuild(mine.bytes, {
      signature: readZip(other.bytes).get('signature')!,
    });

    const verdict = await verifyPkPass(swapped, { trustedRoots: signer.trustedRoots });

    expect(verdict.valid).toBe(false);
    expect(verdict.signature.verified).toBe(false);
  });

  it('catches an unsigned archive', async () => {
    const pass = await buildPkPass(sampleContent(), signer.material, { builtAt: BUILT_AT });
    const stripped = rebuild(pass.bytes, { signature: null });

    const verdict = await verifyPkPass(stripped, { trustedRoots: signer.trustedRoots });

    expect(verdict.signature.present).toBe(false);
    expect(verdict.problems).toContainEqual(
      expect.objectContaining({ rule: 'signatureVerifies', path: 'signature' }),
    );
  });

  /**
   * The check that proves the chain check is real.
   *
   * Without it every signature assertion in this file would pass for a
   * certificate issued by anybody at all — which is exactly the situation a
   * development certificate puts a product in, and the reason `selfSigned` is
   * reported rather than inferred.
   */
  it('rejects a perfectly valid signature from a certificate we do not trust', async () => {
    const stranger = await testSigner({ passTypeIdentifier: 'pass.someone.else' });
    const pass = await buildPkPass(sampleContent(), stranger.material, { builtAt: BUILT_AT });

    const unchecked = await verifyPkPass(pass.bytes);
    expect(unchecked.signature.verified).toBe(true);
    expect(unchecked.signature.chainChecked).toBe(false);

    const checked = await verifyPkPass(pass.bytes, { trustedRoots: signer.trustedRoots });
    expect(checked.valid).toBe(false);
    expect(checked.signature.verified).toBe(false);
  });

  it('catches an @2x image that is not exactly twice its base', async () => {
    const pass = await buildPkPass(
      sampleContent({
        assets: {
          icon: { x1: solidPng(29, 29), x2: solidPng(57, 58) },
          strip: { x1: solidPng(375, 123) },
        },
      }),
      signer.material,
      { builtAt: BUILT_AT, ignoreProblems: true },
    );

    const verdict = await verifyPkPass(pass.bytes, { trustedRoots: signer.trustedRoots });

    // Apple scales what it is given, so this is a blurred icon and no error.
    expect(verdict.problems).toContainEqual(
      expect.objectContaining({ rule: 'densityMultiples', path: 'icon@2x.png' }),
    );
  });

  it('catches an archive that is not an archive', async () => {
    const verdict = await verifyPkPass(Buffer.from('this is not a pkpass'));

    expect(verdict.valid).toBe(false);
    expect(verdict.problems[0]?.message).toMatch(/could not be read/);
  });

  it('refuses to build a pass that breaks a rule, rather than signing it', async () => {
    await expect(
      buildPkPass(
        sampleContent({
          primary: [{ key: 'reward', value: 'x', changeMessage: 'it changed' }],
        }),
        signer.material,
        { builtAt: BUILT_AT },
      ),
    ).rejects.toThrow(/%@/);
  });
});
