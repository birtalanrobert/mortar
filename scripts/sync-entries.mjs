#!/usr/bin/env node
/**
 * Generates stub folders for subpath entry points.
 *
 * Consuming NestJS projects typically use `moduleResolution: "node"`, which
 * predates and therefore ignores the `exports` map. A physical folder holding
 * a tiny package.json is the only form of subpath that every resolver
 * understands, so we generate one per declared entry.
 *
 * Driven by the `mortar.entries` field in each package.json.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const packagesDir = 'packages';

for (const name of readdirSync(packagesDir)) {
  const pkgPath = join(packagesDir, name, 'package.json');
  if (!existsSync(pkgPath)) continue;

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

  // npm resolves LICENSE and NOTICE per package directory, not from the repo
  // root, so each published package gets its own copy. Regenerated here rather
  // than committed, so they cannot drift from the canonical pair.
  for (const file of ['LICENSE', 'NOTICE']) {
    if (existsSync(file)) copyFileSync(file, join(packagesDir, name, file));
  }

  const entries = pkg.mortar?.entries ?? [];

  for (const entry of entries) {
    const dir = join(packagesDir, name, entry);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify(
        {
          // Not published as its own package; this exists purely so that
          // `require('@birtalanrobert/x/entry')` resolves under node10 resolution.
          main: `../dist/${entry}/index.js`,
          types: `../dist/${entry}/index.d.ts`,
          sideEffects: false,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(`  ${pkg.name}/${entry} -> dist/${entry}`);
  }
}
