#!/usr/bin/env node
/**
 * Sets or bumps package versions.
 *
 *   pnpm version:set 1.0.0                    every package
 *   pnpm version:set 1.1.0 http auth          only those
 *   pnpm version:bump minor observability     patch | minor | major
 *
 * Versions are per package, not lockstep. Only what changed gets a new version,
 * and `pnpm release` publishes only what the registry does not already have.
 *
 * Internal dependency ranges are normalised to `workspace:^` on every run.
 * pnpm rewrites that at publish time to `^<current version>`, which is what
 * lets one package be released without republishing the eleven others: a
 * caret range accepts later minors, an exact pin does not, and an exact pin
 * across a family makes npm install several copies of the same package the
 * moment two versions coexist in one tree.
 */
import { readPackages, writeManifest, SCOPE } from './packages.mjs';

const [mode, ...rest] = process.argv.slice(2);
const BUMPS = ['patch', 'minor', 'major'];

if (!mode) {
  console.error('Usage: version.mjs <version|patch|minor|major> [package...]');
  process.exit(1);
}

const bumping = BUMPS.includes(mode);
if (!bumping && !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(mode)) {
  console.error(`Not a version or a bump: ${mode}`);
  console.error(`Expected 1.2.3, or one of: ${BUMPS.join(', ')}`);
  process.exit(1);
}

const packages = readPackages();
const selected = rest.length > 0 ? rest.map(normalise) : packages.map((pkg) => pkg.dir);

const unknown = selected.filter((dir) => !packages.some((pkg) => pkg.dir === dir));
if (unknown.length > 0) {
  console.error(`No such package: ${unknown.join(', ')}`);
  console.error(`Available: ${packages.map((pkg) => pkg.dir).join(', ')}`);
  process.exit(1);
}

for (const pkg of packages) {
  const before = pkg.version;

  if (selected.includes(pkg.dir)) {
    pkg.manifest.version = bumping ? bump(before, mode) : mode;
  }

  normaliseRanges(pkg.manifest);
  writeManifest(pkg);

  if (pkg.manifest.version !== before) {
    console.log(`  ${pkg.name}  ${before} → ${pkg.manifest.version}`);
  }
}

console.log(`\nRun \`pnpm install\` to refresh the lockfile, then \`pnpm release\`.`);

/** Accepts either the directory name or the full package name. */
function normalise(name) {
  return name.startsWith(`${SCOPE}/`) ? name.slice(SCOPE.length + 1) : name;
}

function bump(version, kind) {
  // Deliberately strict about pre-release tags: bumping one is a decision with
  // several defensible answers, and guessing wrong is worse than refusing.
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Cannot bump a pre-release version automatically: ${version}`);

  const [major, minor, patch] = match.slice(1).map(Number);
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function normaliseRanges(manifest) {
  for (const field of ['dependencies', 'peerDependencies']) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (name.startsWith(`${SCOPE}/`) && String(range).startsWith('workspace:')) {
        manifest[field][name] = 'workspace:^';
      }
    }
  }
}
