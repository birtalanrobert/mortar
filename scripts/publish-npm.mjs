#!/usr/bin/env node
/**
 * Publishes to the public npm registry whatever is not published yet.
 *
 * Three things it deliberately does:
 *
 *  - **Skips what the registry already has.** Versions are bumped per package,
 *    so most runs republish two or three of the twelve. Asking npm first turns
 *    "already exists" from a failure into a no-op.
 *  - **Keeps going after a failure**, but only where that is safe. A package
 *    that fails blocks everything downstream of it — publishing `auth` against
 *    an `http` that never made it produces a release that cannot install — so
 *    its dependents are skipped and everything unrelated still goes out.
 *  - **Never unpublishes.** npm forbids it after 72 hours, and it would be
 *    reckless in the meantime.
 *
 * Usage: pnpm release          (or `--dry-run` to see exactly what would ship)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dependentsOf, inDependencyOrder, readPackages } from './packages.mjs';

const dryRun = process.argv.includes('--dry-run');

function run(command, args, cwd = '.') {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

if (!dryRun) {
  const dirty = run('git', ['status', '--porcelain']).trim();
  if (dirty) {
    console.error('Refusing to publish with uncommitted changes:\n' + dirty);
    console.error('\nA published version must correspond to a commit that exists.');
    process.exit(1);
  }

  // Pre-flight the two things that fail every first publish, so they are
  // reported as instructions rather than as an opaque registry error.
  let user;
  try {
    user = run('npm', ['whoami']).trim();
  } catch {
    console.error('Not logged in to npm.\n\n  npm login\n');
    process.exit(1);
  }

  const scope = JSON.parse(readFileSync('packages/money/package.json', 'utf8')).name.split('/')[0];
  const org = scope.slice(1);

  if (org !== user) {
    // npm permits a scope only when it is your username or an organisation you
    // belong to. A scope that is neither fails on every package with an error
    // that never mentions the organisation.
    let belongs = false;
    try {
      belongs = run('npm', ['org', 'ls', org]).includes(user);
    } catch {
      // Left false. Assigning it again here says the same thing twice, which
      // eslint 10's `no-useless-assignment` objects to — the initialiser above
      // is the answer for every failing path.
    }

    if (!belongs) {
      console.error(`The npm organisation '${org}' does not exist, or '${user}' is not a member.`);
      console.error(`\nEvery package here is published under '${scope}', and npm allows a scope`);
      console.error(`only when it is your username or an organisation you belong to.`);
      console.error(`\nCreate it once, free for public packages:`);
      console.error(`\n  https://www.npmjs.com/org/create   (name it exactly: ${org})`);
      console.error(`\nThen re-run. Nothing has been published.`);
      process.exit(1);
    }
  }
}

const packages = readPackages();
const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
const ordered = inDependencyOrder(packages);

console.log(dryRun ? 'Dry run — nothing will be published.\n' : 'Publishing to npm.\n');

/** Already on the registry at this exact version. */
function isPublished(spec) {
  try {
    run('npm', ['view', spec, 'version']);
    return true;
  } catch {
    return false;
  }
}

/**
 * A package whose own dependencies are not all on the registry.
 *
 * Checked before publishing rather than only after a failure in this run,
 * because the two are not the same. A package that failed on one run leaves
 * the block behind; on the next run its dependents are no longer blocked —
 * their versions still are not published, so nothing skips them — and they go
 * out against a dependency that does not exist. Everything then installs with
 * ETARGET, and the only clue is a package missing from a list of twelve.
 */
function unpublishedDependencies(pkg) {
  return (
    pkg.dependencies
      .map((name) => byName.get(name))
      .filter(Boolean)
      // Handled earlier in this run. In a real run it is now on the registry; in
      // a dry run it would be. Either way it is not the stale-dependency case
      // this guard is looking for.
      .filter((dep) => !handled.has(dep.name))
      .filter((dep) => !isPublished(`${dep.name}@${dep.version}`))
      .map((dep) => `${dep.name}@${dep.version}`)
  );
}

/** Names dealt with earlier in this run — published, or would be. */
const handled = new Set();
const published = [];
const skipped = [];
const failed = [];
/** Names whose dependents must not be published: their dependency did not ship. */
const blocked = new Set();

for (const pkg of ordered) {
  const spec = `${pkg.name}@${pkg.version}`;

  if (blocked.has(pkg.name)) {
    console.log(`  ⊘ ${spec} skipped — a package it depends on failed`);
    continue;
  }

  // Checked in dry runs too. A dry run that claims it would publish something
  // the registry already has is a dry run that answers the wrong question.
  if (isPublished(spec)) {
    console.log(`  – ${spec} already published, skipping`);
    handled.add(pkg.name);
    skipped.push(spec);
    continue;
  }

  // Anything published in this run is on the registry by the time we get
  // here, so what remains is a version an earlier run failed to publish.
  const missing = unpublishedDependencies(pkg);
  if (missing.length > 0) {
    console.error(`  ⊘ ${spec} held back — depends on unpublished ${missing.join(', ')}`);
    blocked.add(pkg.name);
    failed.push(spec);
    continue;
  }

  if (dryRun) {
    console.log(`  ✓ ${spec} would be published`);
    handled.add(pkg.name);
    published.push(spec);
    continue;
  }

  try {
    // stdio: 'inherit' is load-bearing, not cosmetic. With two-factor auth on
    // the account npm runs an interactive browser flow to collect a one-time
    // password; capturing its output swallows the prompt and the publish fails
    // with an opaque EOTP. Inheriting also means npm's own progress is visible
    // live, which is what you want during a real publish anyway.
    execFileSync('pnpm', ['publish', '--access', 'public'], {
      cwd: join('packages', pkg.dir),
      stdio: 'inherit',
      encoding: 'utf8',
    });
    console.log(`  ✓ ${spec}`);
    handled.add(pkg.name);
    published.push(spec);
  } catch (error) {
    console.error(`\n  ✗ ${spec}`);

    // With inherited stdio npm has already printed the reason above, so only
    // add guidance the raw error does not give. Both streams, and never `??`:
    // an empty stdout Buffer is neither null nor undefined, so `??` would keep
    // it and hide the real error in stderr.
    const detail = [error.stdout, error.stderr, error.message]
      .map((part) => (part ? String(part).trim() : ''))
      .filter(Boolean)
      .join('\n');
    if (detail.includes('E409') || detail.includes('previously staged')) {
      // npm keeps a partial record when a publish is interrupted mid-upload.
      // That name and version are then permanently unusable — it cannot be
      // unpublished, and retrying returns the same 409 forever.
      const [, version] = spec.split('@').slice(-2);
      console.error(
        `\nnpm has a partially-staged ${spec} from an interrupted publish.\n` +
          `That version is spent: it cannot be republished or removed. Bump past it:\n\n` +
          `  pnpm version:bump patch ${pkg.dir}\n` +
          `  pnpm install && pnpm release\n\n` +
          `Packages already published that depend on ${version} need no change — a\n` +
          `caret range accepts the patch, which is the point of them.\n`,
      );
    } else if (detail.includes('EOTP')) {
      console.error(
        '\nTwo-factor auth is required for publishing. Either relax it to\n' +
          'authorisation-only, or use an automation token:\n\n' +
          '  https://www.npmjs.com/settings/~/tfa          → "Authorization only"\n' +
          '  https://www.npmjs.com/settings/~/tokens/new   → Granular, type "Automation"\n',
      );
    } else if (detail) {
      console.error(detail);
    }

    failed.push(spec);
    for (const dependent of dependentsOf(pkg.name, packages)) blocked.add(dependent);
  }
}

console.log('');
if (published.length > 0) {
  console.log(`${dryRun ? 'Would publish' : 'Published'}: ${published.length}`);
}
if (skipped.length > 0) console.log(`Unchanged, already on npm: ${skipped.length}`);

if (failed.length > 0) {
  console.error(`\nFailed: ${failed.join(', ')}`);
  if (blocked.size > 0) {
    console.error(`Held back because they depend on a failure: ${[...blocked].join(', ')}`);
  }
  console.error('\nWhatever published is fine and will be skipped next time. Fix and re-run.');
  process.exit(1);
}

console.log(dryRun ? '\nDry run complete.' : '\nDone.');
