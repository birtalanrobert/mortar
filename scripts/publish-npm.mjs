#!/usr/bin/env node
/**
 * Publishes every package to the public npm registry.
 *
 * Separate from `publish-local.mjs` because the two differ in ways that matter:
 * this one never unpublishes (npm forbids it after 72 hours and it would be
 * reckless anyway), refuses to run on a dirty tree, and stops at the first
 * failure rather than pressing on — a half-published set of interdependent
 * packages is worse than none.
 *
 * Usage: pnpm release          (or `--dry-run` to see exactly what would ship)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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
      belongs = false;
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

// Dependency order, so a package is never published before something it needs.
const ORDER = [
  'money',
  'context',
  'config',
  'observability',
  'redis',
  'database',
  'http',
  'audit',
  'idempotency',
  'tenancy',
  'auth',
  'jobs',
];

const known = readdirSync('packages').filter((d) =>
  existsSync(join('packages', d, 'package.json')),
);
const missing = known.filter((d) => !ORDER.includes(d));
if (missing.length > 0) {
  console.error(`These packages are not in the publish order: ${missing.join(', ')}`);
  console.error('Add them to ORDER in scripts/publish-npm.mjs, in dependency order.');
  process.exit(1);
}

console.log(dryRun ? 'Dry run — nothing will be published.\n' : 'Publishing to npm.\n');

for (const dir of ORDER) {
  const pkg = JSON.parse(readFileSync(join('packages', dir, 'package.json'), 'utf8'));
  const spec = `${pkg.name}@${pkg.version}`;

  if (!dryRun) {
    // Already published at this version? Skip rather than fail the whole run.
    try {
      run('npm', ['view', spec, 'version']);
      console.log(`  – ${spec} already published, skipping`);
      continue;
    } catch {
      // Not published, which is what we want.
    }
  }

  try {
    // --no-git-checks in both modes: the clean-tree requirement is enforced
    // above, with a message that says which files are dirty. Leaving pnpm's
    // own check on would mean two definitions of 'clean' and a second, vaguer
    // error — and would break a dry run, which exists to be inspected
    // *before* committing.
    const args = ['publish', '--access', 'public', '--no-git-checks'];
    if (dryRun) args.push('--dry-run');
    const output = run('pnpm', args, join('packages', dir));
    const fileCount = /(\d+)\s+files?/.exec(output)?.[1] ?? '?';
    console.log(`  ✓ ${spec} (${fileCount} files)`);
  } catch (error) {
    console.error(`  ✗ ${spec}\n`);
    // Both streams, and never `??`: an empty stdout Buffer is neither null nor
    // undefined, so `??` would keep it and hide the real error in stderr.
    const detail = [error.stdout, error.stderr, error.message]
      .map((part) => (part ? String(part).trim() : ''))
      .filter(Boolean)
      .join('\n');
    console.error(detail || '(no output captured)');
    console.error('\nStopped. Packages already published are fine; fix and re-run.');
    process.exit(1);
  }
}

console.log(dryRun ? '\nDry run complete.' : '\nPublished.');
