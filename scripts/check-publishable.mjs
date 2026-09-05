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
    /*
     * Subdomains of the reserved documentation domains are allowed too, which
     * the hostname rule above already does. RFC 2606 reserves `example.com`
     * and everything under it precisely so that documentation can name an
     * address; flagging `docs@in.example.com` while permitting
     * `https://in.example.com` was an inconsistency between two rules meant to
     * express the same policy.
     *
     * The allowlist must consume the *whole* domain, hence the trailing
     * lookahead: without it `someone@example.com.attacker.net` is read as
     * beginning with a permitted domain and waved through, which is a
     * lookalike anybody can register.
     */
    pattern: new RegExp(
      '[A-Za-z0-9._%+-]+@(?!(?:' +
        [
          '(?:[a-z0-9-]+\\.)*example\\.(?:com|org|net)',
          'x\\.com',
          'y\\.hu',
          '(?:[a-z0-9-]+\\.)*mortar\\.dev',
        ].join('|') +
        ')(?![A-Za-z0-9.-]))[A-Za-z0-9.-]+\\.[A-Za-z]{2,}',
    ),
  },
];

let findings = 0;

for (const dir of readdirSync('packages')) {
  const manifestPath = join('packages', dir, 'package.json');
  if (!existsSync(manifestPath)) continue;
  const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));

  /*
   * A scoped package defaults to *restricted*, and npm refuses to publish it
   * publicly without being told.
   *
   * The failure is not an error at publish time — the release reports success —
   * it is a 404 in whichever repository tries to install it next, saying the
   * package "is not in the npm registry, or you have no permission". That cost
   * a round trip the first time `commerce` was released, which is why it is
   * checked here rather than remembered.
   */
  if (pkg.publishConfig?.access !== 'public') {
    console.error(`  ✗ ${pkg.name} → package.json`);
    console.error('    publishConfig.access must be "public", or the publish is private');
    findings += 1;
  }

  /*
   * And where the source is, which the AGPL's "corresponding source" is about
   * and which npm shows beside the package.
   */
  if (!pkg.repository?.url || !pkg.repository?.directory) {
    console.error(`  ✗ ${pkg.name} → package.json`);
    console.error('    repository.url and repository.directory are missing');
    findings += 1;
  }

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
