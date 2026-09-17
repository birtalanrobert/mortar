import { createZip } from '@birtalanrobert/files/zip';
import { BusinessRuleError } from '@birtalanrobert/http';
import type { ImageSet, PassAssets, PassContent } from '../content';
import { identityOf, readSigningCertificate, type SigningCertificate } from './certificate';
import { buildManifest, serialiseManifest } from './manifest';
import { buildPassJson, buildPassStrings, type PassJson } from './pass-json';
import type { PassProblem } from './rules';
import { signDetached, type SigningMaterial } from './sign';
import { validateContent } from './validate';

export interface BuildOptions {
  /**
   * The moment written into the signature and into every archive entry.
   *
   * Given one, the same content produces the same bytes — which is what the
   * golden-file tests rest on and what makes "did this pass change" a question
   * with an answer. Left out, it is now.
   */
  builtAt?: Date;
  /**
   * Build the archive even though the content breaks a rule.
   *
   * Exists for exactly one caller: the conformance tests, which have to be able
   * to produce a bad pass in order to prove the checker catches it. Anything
   * else using this is building a pass that will be refused by a device, which
   * is the thing this package was written to prevent.
   */
  ignoreProblems?: boolean;
}

export interface BuiltPass {
  /** The `.pkpass` archive. */
  bytes: Buffer;
  /** What went into it, for a caller that wants to show or store it. */
  passJson: PassJson;
  manifest: Record<string, string>;
  certificate: SigningCertificate;
  /**
   * Rules the content broke.
   *
   * Empty unless `ignoreProblems` was set — otherwise the build throws instead
   * of returning them, because a pass that breaks a rule is not a pass.
   */
  problems: PassProblem[];
}

/**
 * Builds and signs a `.pkpass`.
 *
 * The order matters and is the whole of it: validate, render, hash every file,
 * sign the hashes, and only then zip. Signing anything other than the finished
 * manifest — or hashing the manifest into itself — produces an archive that is
 * internally inconsistent in a way no error message explains.
 */
export async function buildPkPass(
  content: PassContent,
  material: SigningMaterial,
  options: BuildOptions = {},
): Promise<BuiltPass> {
  const certificate = readSigningCertificate(material.certificate);

  const problems = validateContent(content);
  if (problems.length > 0 && !options.ignoreProblems) {
    throw new BusinessRuleError('pass_invalid', 'This pass would be refused', describe(problems), {
      meta: { problems },
    });
  }

  const passJson = buildPassJson(content, identityOf(certificate));

  const files = new Map<string, Uint8Array>();
  files.set('pass.json', Buffer.from(JSON.stringify(passJson), 'utf8'));

  for (const [name, bytes] of assetFiles(content.assets)) files.set(name, bytes);

  for (const [locale, strings] of Object.entries(content.localisations ?? {})) {
    files.set(`${locale}.lproj/pass.strings`, Buffer.from(buildPassStrings(strings), 'utf8'));
  }

  const manifest = buildManifest(files);
  const manifestBytes = serialiseManifest(manifest);

  const signature = await signDetached(manifestBytes, material, {
    ...(options.builtAt ? { signedAt: options.builtAt } : {}),
  });

  /*
   * The manifest and the signature go in *after* the manifest is computed, and
   * are deliberately not in it. Apple's own layout: the manifest covers the
   * content, the signature covers the manifest, and neither covers itself.
   */
  const entries = [...files.entries()].map(([path, bytes]) => ({ path, content: bytes }));
  entries.push({ path: 'manifest.json', content: manifestBytes });
  entries.push({ path: 'signature', content: signature });

  const bytes = createZip(
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    { modified: options.builtAt ?? new Date() },
  );

  return {
    bytes,
    passJson,
    manifest,
    certificate,
    problems: options.ignoreProblems ? problems : [],
  };
}

/**
 * The image files, at the names Apple looks for.
 *
 * `@2x` and `@3x` are a filename convention rather than metadata, so a
 * mis-spelling here is an image the device never loads and never mentions.
 */
export function assetFiles(assets: PassAssets): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();

  for (const [name, set] of Object.entries(assets ?? {}) as [keyof PassAssets, ImageSet][]) {
    if (!set) continue;
    if (set.x1) files.set(`${name}.png`, set.x1);
    if (set.x2) files.set(`${name}@2x.png`, set.x2);
    if (set.x3) files.set(`${name}@3x.png`, set.x3);
  }

  return files;
}

const describe = (problems: PassProblem[]): string =>
  problems.map((one) => `${one.path}: ${one.message}`).join(' ');
