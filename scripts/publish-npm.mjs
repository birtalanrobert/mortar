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
}

// Dependency order, so a package is never published before something it needs.
const ORDER = [
  'money', 'context', 'config', 'observability', 'redis',
  'database', 'http', 'audit', 'idempotency', 'tenancy', 'auth', 'jobs',
];

const known = readdirSync('packages').filter((d) => existsSync(join('packages', d, 'package.json')));
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
    const args = ['publish', '--access', 'public'];
    if (dryRun) {
      // A dry run exists to be inspected *before* committing, so pnpm's own
      // clean-tree requirement is unhelpful here. The real publish still
      // refuses a dirty tree, checked above.
      args.push('--dry-run', '--no-git-checks');
    }
    const output = run('pnpm', args, join('packages', dir));
    const fileCount = /(\d+)\s+files?/.exec(output)?.[1] ?? '?';
    console.log(`  ✓ ${spec} (${fileCount} files)`);
  } catch (error) {
    console.error(`  ✗ ${spec}`);
    console.error(String(error.stdout ?? error.stderr ?? error.message).trim().split('\n').slice(-6).join('\n'));
    console.error('\nStopped. Packages already published are fine; fix and re-run.');
    process.exit(1);
  }
}

console.log(dryRun ? '\nDry run complete.' : '\nPublished.');
