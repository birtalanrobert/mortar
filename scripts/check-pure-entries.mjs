#!/usr/bin/env node
/**
 * A package's root entry point is a bundling decision, not a convenience.
 *
 * Some of these packages are imported by browser bundles, and their root is a
 * promise: everything needing a framework, a database or a vendor's SDK lives
 * behind a subpath. Nothing enforced that promise, and
 * `@birtalanrobert/commerce` broke it the day it gained a Stripe client — the
 * root re-exported `StripeConnect`, and a console that only wanted to divide a
 * price by three shipped a payments SDK to everybody who opened the diary.
 *
 * It surfaced two repositories away as a bundle budget failure, which is a very
 * long way from the export that caused it. So the check belongs here, where the
 * decision is made.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPackages } from './packages.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The packages a browser bundle imports by name, and so must keep pure.
 *
 * Named rather than inferred. Having a `./nestjs` subpath is not the same claim
 * — `comms` and `files` split theirs to keep a Nest module out of a worker's
 * import graph, and nothing in a browser has ever imported either. Listing the
 * real ones keeps this a check somebody can act on rather than a standing
 * failure everybody learns to scroll past.
 *
 * Add to it when a product's front end starts importing a package's root.
 */
const BROWSER_IMPORTED = new Set([
  '@birtalanrobert/billing',
  '@birtalanrobert/commerce',
  '@birtalanrobert/config',
  '@birtalanrobert/http',
  '@birtalanrobert/messaging',
  '@birtalanrobert/money',
  '@birtalanrobert/vouchers',
  '@birtalanrobert/workflow',
]);

/**
 * Third-party imports such a root may still make.
 *
 * Each has to earn its place by being framework-free and small enough that a
 * phone on a slow connection does not pay for it.
 */
const ALLOWED = new Set(['zod']);

const IMPORT = /(?:^|\n)\s*(?:import|export)[\s\S]{0,400}?from\s*['"]([^'"]+)['"]/g;

/**
 * Comments out, before anything is matched.
 *
 * The first version of this read `from "..."` out of a sentence in a doc
 * comment and reported prose as a dependency — a guard that cries wolf is a
 * guard that gets disabled.
 */
const withoutComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/** Every module reachable from an entry file, following relative imports only. */
function graph(entry) {
  const seen = new Set();
  const queue = [entry];
  const external = new Map();

  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);

    const source = withoutComments(readFileSync(file, 'utf8'));

    for (const [, specifier] of source.matchAll(IMPORT)) {
      if (specifier.startsWith('.')) {
        const target = resolve(dirname(file), specifier);
        queue.push(target.endsWith('.ts') ? target : `${target}.ts`);
        queue.push(join(target, 'index.ts'));
        continue;
      }

      if (!external.has(specifier)) external.set(specifier, file);
    }
  }

  return external;
}

let failed = false;

for (const pkg of readPackages(join(ROOT, 'packages'))) {
  if (!BROWSER_IMPORTED.has(pkg.name)) continue;

  const entry = join(ROOT, 'packages', pkg.dir, 'src/index.ts');
  if (!existsSync(entry)) continue;

  const offences = [...graph(entry)].filter(([specifier]) => {
    if (ALLOWED.has(specifier)) return false;

    // Another mortar package's own pure root is fine; its `/nestjs` is not.
    if (/^@birtalanrobert\/[a-z-]+$/.test(specifier)) return false;

    // A type-only import of the framework would be harmless, but there is no
    // way to tell one from the other by reading the specifier, and the safe
    // answer keeps the rule simple enough to obey.
    return true;
  });

  if (offences.length > 0) {
    failed = true;
    console.error(`\n  ✗ ${pkg.name} — the root entry point is not pure`);
    for (const [specifier, file] of offences) {
      console.error(`      ${specifier}  (from ${file.slice(ROOT.length + 1)})`);
    }
  } else {
    console.log(`  ✓ ${pkg.name}`);
  }
}

if (failed) {
  console.error(
    '\nMove it behind a subpath. Raising a bundle budget downstream is not the fix —\n' +
      'the package is what decided to ship it.\n',
  );
  process.exit(1);
}

console.log('\nEvery pure entry point is pure.\n');
