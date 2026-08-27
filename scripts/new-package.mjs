#!/usr/bin/env node
/**
 * Scaffolds a new @birtalanrobert/* package with identical structure.
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
      name: `@birtalanrobert/${name}`,
      version: '0.1.0',
      description: description ?? '',
      license: 'AGPL-3.0-only',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      files: [
        'dist',
        'src',
        // npm's allowlist wins over .npmignore, so tests are excluded here.
        '!src/**/*.test.ts',
        '!src/**/*.spec.ts',
        'README.md',
        'LICENSE',
        'NOTICE',
      ],
      exports: {
        '.': { types: './dist/index.d.ts', default: './dist/index.js' },
        // Bundlers and some libraries read a dependency's package.json; an
        // exports map that omits it turns that into an obscure failure.
        './package.json': './package.json',
      },
      scripts: {
        build: 'tsc -p tsconfig.build.json',
        clean: 'rm -rf dist *.tsbuildinfo',
        typecheck: 'tsc -p tsconfig.json --noEmit',
      },
      publishConfig: { access: 'public' },
    },
    null,
    2,
  ) + '\n',
);

/**
 * Two configurations, and the pair is the point.
 *
 * `tsconfig.build.json` emits and excludes tests, because tests have no place
 * in a published `dist`. `tsconfig.json` emits nothing and **includes** them,
 * because that is the project an editor and `pnpm typecheck` resolve.
 *
 * One config doing both jobs looks tidier and silently stops type-checking the
 * tests: the build is green, the editor is red, and nobody sees the editor
 * until they open the file. That is exactly how it went wrong the first time.
 */
writeFileSync(
  join(dir, 'tsconfig.build.json'),
  JSON.stringify(
    {
      extends: '../../tsconfig.base.json',
      compilerOptions: { outDir: './dist', rootDir: './src', types: ['node'] },
      include: ['src/**/*'],
      exclude: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'src/**/__tests__/**'],
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
      compilerOptions: { noEmit: true, types: ['node'] },
      include: ['src/**/*'],
    },
    null,
    2,
  ) + '\n',
);

writeFileSync(join(dir, 'src', 'index.ts'), '');
writeFileSync(join(dir, 'README.md'), `# @birtalanrobert/${name}\n\n${description ?? ''}\n`);

console.log(`Created packages/${name}`);
