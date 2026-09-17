import { createHash } from 'node:crypto';
import { readZip } from '@birtalanrobert/files/zip';
import { readPngSize } from './png';
import { ASSET_SIZES, type PassProblem, type RuleName } from './rules';
import { verifyDetached } from './sign';
import { validatePassJson } from './validate';

/**
 * The conformance check: a finished `.pkpass`, opened and held against the rules.
 *
 * This is what stands in for a phone. It reads the archive back from its bytes
 * — not from whatever the builder thought it wrote — re-derives every hash,
 * verifies the signature cryptographically, and applies {@link RULES} to the
 * `pass.json` that is actually in the file.
 *
 * What it cannot tell anyone is whether a lock screen renders the result as
 * intended, or whether Apple's servers accept the certificate. Those are named
 * in the plan as unprovable here rather than quietly implied by a green check.
 */
export interface VerifyOptions {
  /**
   * Trust anchors the signing certificate must chain to.
   *
   * For a real pass that is Apple's root. Omitted, the signature is still
   * verified — the bytes were signed by the key in the container — but nothing
   * says whose key it is, which is the situation every test with a generated
   * certificate is in, and is why the verdict reports the two separately.
   */
  trustedRoots?: readonly (Buffer | string)[];
}

export interface PassVerdict {
  valid: boolean;
  problems: PassProblem[];
  /** The archive's contents, by name, for a caller that wants to look further. */
  files: string[];
  passJson?: Record<string, unknown>;
  signature: {
    present: boolean;
    verified: boolean;
    /** Whether a chain was actually checked, rather than assumed. */
    chainChecked: boolean;
    signer?: string;
    reason?: string;
  };
}

/** Everything in the archive that the manifest is *not* expected to cover. */
const UNHASHED = new Set(['manifest.json', 'signature']);

export async function verifyPkPass(
  archive: Uint8Array,
  options: VerifyOptions = {},
): Promise<PassVerdict> {
  const problems: PassProblem[] = [];
  const add = (rule: RuleName, path: string, message: string) =>
    problems.push({ rule, path, message });

  let files: Map<string, Buffer>;
  try {
    files = readZip(archive);
  } catch (cause) {
    return {
      valid: false,
      problems: [
        {
          rule: 'manifestCoversArchive',
          path: '.pkpass',
          message: `The archive could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
        },
      ],
      files: [],
      signature: { present: false, verified: false, chainChecked: false },
    };
  }

  const names = [...files.keys()].sort();

  for (const required of ['pass.json', 'manifest.json', 'signature']) {
    if (!files.has(required)) {
      add('manifestCoversArchive', required, `The archive has no ${required}.`);
    }
  }

  if (!files.has('icon.png')) {
    add('iconRequired', 'icon.png', 'icon.png is required and is not in the archive.');
  }

  /* --- the manifest, checked in both directions --- */

  const manifestBytes = files.get('manifest.json');
  let manifest: Record<string, string> | undefined;

  if (manifestBytes) {
    try {
      manifest = JSON.parse(manifestBytes.toString('utf8')) as Record<string, string>;
    } catch {
      add('manifestCoversArchive', 'manifest.json', 'manifest.json is not JSON.');
    }
  }

  if (manifest) {
    for (const [name, expected] of Object.entries(manifest)) {
      const content = files.get(name);
      if (!content) {
        add(
          'manifestCoversArchive',
          `manifest.json/${name}`,
          `The manifest names "${name}", which is not in the archive.`,
        );
        continue;
      }

      const actual = createHash('sha1').update(content).digest('hex');
      if (actual !== expected.toLowerCase()) {
        add(
          'manifestCoversArchive',
          name,
          `"${name}" hashes to ${actual}; the manifest says ${expected}.`,
        );
      }
    }

    /*
     * The other direction, which is the one that gets forgotten. A file in the
     * archive that no manifest entry covers is rejected by the device with a
     * message that names nothing useful, and a checker that only walks the
     * manifest agrees the pass is fine.
     */
    for (const name of names) {
      if (UNHASHED.has(name)) continue;
      if (!(name in manifest)) {
        add(
          'manifestCoversArchive',
          name,
          `"${name}" is in the archive and not in the manifest. Every file must be hashed.`,
        );
      }
    }
  }

  /* --- the signature --- */

  const signatureBytes = files.get('signature');
  const chainChecked = (options.trustedRoots?.length ?? 0) > 0;
  let signature: PassVerdict['signature'] = {
    present: Boolean(signatureBytes),
    verified: false,
    chainChecked,
  };

  if (signatureBytes && manifestBytes) {
    const verdict = await verifyDetached(signatureBytes, manifestBytes, options.trustedRoots ?? []);
    signature = {
      present: true,
      verified: verdict.verified,
      chainChecked,
      ...(verdict.signer ? { signer: verdict.signer } : {}),
      ...(verdict.reason ? { reason: verdict.reason } : {}),
    };

    if (!verdict.verified) {
      add('signatureVerifies', 'signature', verdict.reason ?? 'The signature did not verify.');
    }
  } else if (!signatureBytes) {
    add('signatureVerifies', 'signature', 'The archive is not signed.');
  }

  /* --- the pass itself --- */

  let passJson: Record<string, unknown> | undefined;
  const passBytes = files.get('pass.json');

  if (passBytes) {
    try {
      passJson = JSON.parse(passBytes.toString('utf8')) as Record<string, unknown>;
      problems.push(...validatePassJson(passJson));
    } catch {
      add('requiredKeys', 'pass.json', 'pass.json is not JSON.');
    }
  }

  /* --- the images, measured from the bytes in the archive --- */

  problems.push(...verifyArchivedImages(files));

  return {
    valid: problems.length === 0,
    problems,
    files: names,
    ...(passJson ? { passJson } : {}),
    signature,
  };
}

/**
 * Image checks done against what is in the file.
 *
 * The builder already checked the `ImageSet` it was handed; this checks the PNGs
 * that ended up in the archive, which is a different claim — a build step that
 * renames, re-encodes or drops a density is invisible to the first check and
 * obvious to this one.
 */
function verifyArchivedImages(files: ReadonlyMap<string, Buffer>): PassProblem[] {
  const problems: PassProblem[] = [];
  const sizes = new Map<string, { width: number; height: number }>();

  for (const [name, content] of files) {
    if (!name.endsWith('.png')) continue;

    const size = readPngSize(content);
    if (!size) {
      problems.push({ rule: 'pngOnly', path: name, message: `${name} is not a PNG.` });
      continue;
    }
    sizes.set(name, size);
  }

  for (const [name, size] of sizes) {
    const match = /^([a-z]+)(?:@([23])x)?\.png$/.exec(name);
    if (!match) continue;

    const [, base, density] = match;

    if (!density) {
      const allowed = ASSET_SIZES[base!];
      if (allowed && (size.width > allowed.width || size.height > allowed.height)) {
        problems.push({
          rule: 'styleAssets',
          path: name,
          message: `${name} is ${size.width}×${size.height}; the layout allows up to ${allowed.width}×${allowed.height}.`,
        });
      }
      continue;
    }

    const multiple = Number(density);
    const baseSize = sizes.get(`${base}.png`);

    if (!baseSize) {
      problems.push({
        rule: 'densityMultiples',
        path: name,
        message: `${name} is in the archive without ${base}.png. A density with no base is never loaded.`,
      });
      continue;
    }

    if (size.width !== baseSize.width * multiple || size.height !== baseSize.height * multiple) {
      problems.push({
        rule: 'densityMultiples',
        path: name,
        message: `${name} is ${size.width}×${size.height}; it must be exactly ${baseSize.width * multiple}×${baseSize.height * multiple}.`,
      });
    }
  }

  return problems;
}
