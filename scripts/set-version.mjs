#!/usr/bin/env node
/**
 * Sets every package to one version.
 *
 * These packages are released together as a set, so they share a version.
 * Independent versioning would be defensible if they were independently
 * useful, but they compose — `@birtalanrobert/audit` is not much good without
 * `@birtalanrobert/database` — and a matrix of compatible pairs is a support
 * burden nobody is asking for.
 *
 * Usage: pnpm set-version 0.2.0
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error('Usage: pnpm set-version <x.y.z>');
  process.exit(1);
}

const updated = [];
for (const dir of readdirSync('packages')) {
  const path = join('packages', dir, 'package.json');
  if (!existsSync(path)) continue;

  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  pkg.version = version;

  // `workspace:^` publishes as `^<version>` rather than an exact pin. Exact
  // pins across a family that is always released together cause npm to install
  // several copies of the same package the moment two versions coexist in a
  // dependency tree.
  for (const field of ['dependencies', 'peerDependencies']) {
    for (const [name, range] of Object.entries(pkg[field] ?? {})) {
      if (name.startsWith('@birtalanrobert/') && String(range).startsWith('workspace:')) {
        pkg[field][name] = 'workspace:^';
      }
    }
  }

  writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
  updated.push(pkg.name);
}

const root = JSON.parse(readFileSync('package.json', 'utf8'));
root.version = version;
writeFileSync('package.json', JSON.stringify(root, null, 2) + '\n');

console.log(`Set ${updated.length} packages to ${version}`);
