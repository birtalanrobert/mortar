/**
 * Checks that every symbol a README imports from a mortar package is actually
 * exported by it. Documentation that names something which does not exist is
 * worse than none: it is read as authoritative.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function exportsOf(spec) {
  const [, name, sub] = /^@birtalanrobert\/([^/]+)(?:\/(.+))?$/.exec(spec) ?? [];
  if (!name) return null;
  const file = join('packages', name, 'dist', sub ? `${sub}/index.d.ts` : 'index.d.ts');
  if (!existsSync(file)) return null;
  const s = readFileSync(file, 'utf8');
  const out = new Set();
  for (const m of s.matchAll(/export\s*\{([^}]*)\}/g))
    for (const n of m[1].split(',')) {
      const t = n
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (t) out.add(t);
    }
  for (const m of s.matchAll(/export declare (?:const|function|class|abstract class) (\w+)/g))
    out.add(m[1]);
  for (const m of s.matchAll(/export (?:interface|type) (\w+)/g)) out.add(m[1]);
  return out;
}

let problems = 0,
  checked = 0;
for (const pkg of readdirSync('packages')) {
  const readme = join('packages', pkg, 'README.md');
  if (!existsSync(readme)) continue;
  const text = readFileSync(readme, 'utf8');
  for (const m of text.matchAll(
    /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'(@birtalanrobert\/[^']+)'/g,
  )) {
    const available = exportsOf(m[2]);
    if (!available) {
      console.log(`  ${pkg}: cannot resolve ${m[2]}`);
      problems++;
      continue;
    }
    for (const raw of m[1].split(',')) {
      const name = raw.trim().replace(/^type\s+/, '');
      if (!name) continue;
      checked++;
      if (!available.has(name)) {
        console.log(`  ${pkg}/README.md: ${m[2]} does not export "${name}"`);
        problems++;
      }
    }
  }
}
console.log(
  problems === 0
    ? `\nAll ${checked} documented imports resolve.`
    : `\n${problems} problem(s) across ${checked} imports.`,
);
