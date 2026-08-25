#!/usr/bin/env node
/**
 * Refuses to publish if something private has crept into a package.
 *
 * The risk with a public registry is not today — today's code is clean. It is
 * month eight, when somebody adds a customer name, an internal hostname or a
 * credential to a mortar package without thinking about where it ends up. This
 * runs before every publish so that mistake fails loudly instead of shipping.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const RULES = [
  {
    name: 'credential',
    pattern:
      /(AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|xox[baprs]-[A-Za-z0-9-]+|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.)/,
  },
  {
    name: 'password in a connection string',
    pattern:
      /(?:postgres|postgresql|redis|mongodb|amqp):\/\/[^:\s'"]+:(?!mortar@|password@|test@)[^@\s'"]{3,}@/,
  },
  {
    name: 'non-public hostname',
    // Anything that is not localhost, a reserved documentation domain
    // (including its subdomains), or ours.
    pattern: new RegExp(
      'https?://(?!' +
        [
          'localhost',
          '127\\.0\\.0\\.1',
          '0\\.0\\.0\\.0',
          '(?:[a-z0-9-]+\\.)*example\\.(?:com|org|net)',
          '(?:[a-z0-9-]+\\.)*mortar\\.dev',
          'registry\\.npmjs\\.org',
          'www\\.npmjs\\.com',
          'github\\.com',
          'aka\\.ms',
          'vite\\.dev',
        ].join('|') +
        ')[a-z0-9.-]+\\.[a-z]{2,}',
      'i',
    ),
  },
  {
    name: 'personal contact detail',
    pattern:
      /[A-Za-z0-9._%+-]+@(?!example\.(?:com|org)|x\.com|y\.hu|mortar\.dev)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  },
];

let findings = 0;

for (const dir of readdirSync('packages')) {
  const manifestPath = join('packages', dir, 'package.json');
  if (!existsSync(manifestPath)) continue;
  const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));

  // Ask npm exactly which files would ship, rather than guessing from `files`.
  let files;
  try {
    const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: join('packages', dir),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    files = JSON.parse(output)[0].files.map((f) => f.path);
  } catch {
    console.error(`  ! could not inspect ${pkg.name}`);
    findings += 1;
    continue;
  }

  for (const relative of files) {
    if (!/\.(ts|js|json|md|map)$/.test(relative)) continue;
    const full = join('packages', dir, relative);
    if (!existsSync(full)) continue;

    const content = readFileSync(full, 'utf8');
    for (const rule of RULES) {
      const match = rule.pattern.exec(content);
      if (match) {
        console.error(`  ✗ ${pkg.name} → ${relative}`);
        console.error(`    ${rule.name}: ${match[0].slice(0, 70)}`);
        findings += 1;
      }
    }
  }
}

if (findings > 0) {
  console.error(
    `\n${findings} issue(s) found. These packages publish publicly — fix before publishing.`,
  );
  process.exit(1);
}
console.log('Publishable: no credentials, private hosts or personal details in any shipped file.');
