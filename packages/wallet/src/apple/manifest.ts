import { createHash } from 'node:crypto';

/**
 * `manifest.json`: every file in the archive, mapped to its SHA-1.
 *
 * SHA-1 because Apple says SHA-1, and this is not a place to be cleverer than
 * the platform. It is not doing cryptography here — the *signature* over this
 * file is what makes the archive tamper-evident, and that is SHA-256. The
 * manifest is an integrity list, and changing its algorithm would produce a
 * pass no device accepts.
 */
export function buildManifest(files: ReadonlyMap<string, Uint8Array>): Record<string, string> {
  const manifest: Record<string, string> = {};

  /*
   * Sorted, so the same set of files always produces the same bytes. JSON
   * objects preserve insertion order, the archive is hashed, and a manifest that
   * reorders itself between builds is a pass the device thinks has changed.
   */
  for (const name of [...files.keys()].sort()) {
    manifest[name] = createHash('sha1').update(files.get(name)!).digest('hex');
  }

  return manifest;
}

/** The manifest as the bytes that are hashed, signed and stored. */
export const serialiseManifest = (manifest: Record<string, string>): Buffer =>
  Buffer.from(JSON.stringify(manifest), 'utf8');
