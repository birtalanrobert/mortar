#!/usr/bin/env node
/**
 * Scaffolds a new @mortar/* package with identical structure.
 * Usage: node scripts/new-package.mjs <name> "<description>"
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [name, description] = process.argv.slice(2);
if (!name) {
  console.error('Usage: node scripts/new-package.mjs <name> "<description>"');
  process.exit(1);
}

const dir = join('packages', name);
if (existsSync(dir)) {
  console.error(`packages/${name} already exists`);
  process.exit(1);
}
mkdirSync(join(dir, 'src'), { recursive: true });

writeFileSync(
  join(dir, 'package.json'),
  JSON.stringify(
    {
      name: `@mortar/${name}`,
      version: '0.1.0',
      description: description ?? '',
      license: 'UNLICENSED',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      files: ['dist', 'README.md'],
      exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
      scripts: {
        build: 'tsc -p tsconfig.json',
        clean: 'rm -rf dist *.tsbuildinfo',
        typecheck: 'tsc -p tsconfig.json --noEmit',
      },
      publishConfig: { access: 'restricted' },
    },
    null,
    2,
  ) + '\n',
);

writeFileSync(
  join(dir, 'tsconfig.json'),
  JSON.stringify(
    {
      extends: '../../tsconfig.base.json',
      compilerOptions: { outDir: './dist', rootDir: './src' },
      include: ['src/**/*'],
      exclude: ['src/**/*.test.ts'],
    },
    null,
    2,
  ) + '\n',
);

writeFileSync(join(dir, 'src', 'index.ts'), '');
writeFileSync(join(dir, 'README.md'), `# @mortar/${name}\n\n${description ?? ''}\n`);

console.log(`Created packages/${name}`);
