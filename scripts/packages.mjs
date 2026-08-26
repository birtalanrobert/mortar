/**
 * The workspace's packages and how they depend on one another.
 *
 * Derived from the manifests rather than kept as a hand-maintained list, so a
 * new package or a new internal dependency is picked up by every script that
 * needs the graph without anyone remembering to update an array.
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SCOPE = '@birtalanrobert';

export function readPackages(root = 'packages') {
  return readdirSync(root)
    .filter((dir) => existsSync(join(root, dir, 'package.json')))
    .map((dir) => {
      const path = join(root, dir, 'package.json');
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      return {
        dir,
        path,
        manifest,
        name: manifest.name,
        version: manifest.version,
        dependencies: internalDependencies(manifest),
      };
    });
}

export function writeManifest(pkg) {
  writeFileSync(pkg.path, `${JSON.stringify(pkg.manifest, null, 2)}\n`);
}

function internalDependencies(manifest) {
  const names = new Set();
  for (const field of ['dependencies', 'peerDependencies']) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (name.startsWith(`${SCOPE}/`)) names.add(name);
    }
  }
  return [...names];
}

/**
 * Packages in dependency order.
 *
 * Kahn's algorithm, with ties broken by name so the order is stable between
 * runs — a publish log that reorders itself for no reason is one nobody can
 * diff. Throws on a cycle, which in a workspace this size means a mistake
 * rather than a design.
 */
export function inDependencyOrder(packages) {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const remaining = new Map(
    packages.map((pkg) => [pkg.name, pkg.dependencies.filter((name) => byName.has(name))]),
  );
  const ordered = [];

  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, deps]) => deps.every((dep) => !remaining.has(dep)))
      .map(([name]) => name)
      .sort();

    if (ready.length === 0) {
      throw new Error(`Dependency cycle among: ${[...remaining.keys()].join(', ')}`);
    }

    for (const name of ready) {
      ordered.push(byName.get(name));
      remaining.delete(name);
    }
  }

  return ordered;
}

/** Every package that depends on `name`, directly or through others. */
export function dependentsOf(name, packages) {
  const found = new Set();
  let changed = true;

  while (changed) {
    changed = false;
    for (const pkg of packages) {
      if (found.has(pkg.name)) continue;
      if (pkg.dependencies.some((dep) => dep === name || found.has(dep))) {
        found.add(pkg.name);
        changed = true;
      }
    }
  }

  return found;
}
