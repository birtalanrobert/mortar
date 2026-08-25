#!/usr/bin/env node
/**
 * Publishes every package to the local registry.
 *
 * Republishing the same version is normal during development and npm refuses
 * it, so each package is unpublished first. The registry is local and
 * anonymous, so this is safe here and would be unthinkable anywhere else.
 *
 * Usage: pnpm publish:local
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REGISTRY = process.env.MORTAR_REGISTRY ?? 'http://localhost:3052';

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

const packages = readdirSync('packages')
  .map((dir) => ({ dir: join('packages', dir), manifest: join('packages', dir, 'package.json') }))
  .filter(({ manifest }) => existsSync(manifest))
  .map(({ dir, manifest }) => ({ dir, pkg: JSON.parse(readFileSync(manifest, 'utf8')) }));

console.log(`Publishing ${packages.length} packages to ${REGISTRY}\n`);

let failed = 0;
for (const { dir, pkg } of packages) {
  const spec = `${pkg.name}@${pkg.version}`;
  try {
    run('npm', ['unpublish', spec, '--force', '--registry', REGISTRY], '.');
  } catch {
    // Not published yet, which is the normal case on a first run.
  }

  try {
    // --no-git-checks: publishing uncommitted work to a local registry is the
    // entire point of this loop.
    run('pnpm', ['publish', '--registry', REGISTRY, '--no-git-checks', '--access', 'public'], dir);
    console.log(`  ✓ ${spec}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${spec}`);
    console.error(String(error.stdout ?? error.message).trim().split('\n').slice(-4).join('\n'));
  }
}

if (failed > 0) {
  console.error(`\n${failed} package(s) failed to publish.`);
  process.exit(1);
}
console.log('\nAll packages published.');
