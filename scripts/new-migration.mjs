#!/usr/bin/env node
/**
 * Scaffolds a TypeORM migration with a real timestamp.
 *
 * TypeORM orders migrations by the number embedded in the class name, so that
 * number must be a genuine moment in time. Hand-picked incrementing values
 * (…001, …002) look tidy in one package and collide the moment two packages,
 * or two developers, pick the same next number — and the resulting ordering is
 * decided by whoever guessed higher rather than by when the change was written.
 *
 * Usage: node scripts/new-migration.mjs <package> <MigrationName>
 *   e.g. node scripts/new-migration.mjs tenancy CreateTenantTables
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [pkg, name] = process.argv.slice(2);

if (!pkg || !name) {
  console.error('Usage: node scripts/new-migration.mjs <package> <MigrationName>');
  process.exit(1);
}
if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) {
  console.error(`Migration name must be PascalCase, received: ${name}`);
  process.exit(1);
}

const dir = join('packages', pkg, 'src', 'migrations');
if (!existsSync(join('packages', pkg))) {
  console.error(`No such package: packages/${pkg}`);
  process.exit(1);
}
mkdirSync(dir, { recursive: true });

const timestamp = Date.now();
const className = `${name}${timestamp}`;
const file = join(dir, `${timestamp}-${name}.ts`);

writeFileSync(
  file,
  `import type { MigrationInterface, QueryRunner } from 'typeorm';

export class ${className} implements MigrationInterface {
  name = '${className}';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(\`
      -- TODO
    \`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(\`
      -- TODO
    \`);
  }
}
`,
);

console.log(`Created ${file}`);
console.log(`Remember to export ${className} from packages/${pkg}/src/index.ts`);
