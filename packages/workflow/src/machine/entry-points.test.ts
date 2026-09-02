import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The main entry must not pull TypeORM in, and nothing in the types says so.
 *
 * This regressed once already while it was being written: adding the log to
 * `src/machine/index.ts` made the barrel import `log.entity`, which imports
 * `typeorm`. Every type still checked, every test still passed, and a Next.js
 * site importing `verifyLink` would have installed an ORM to verify a link.
 *
 * Asserted in a child process, because a test file that has already imported
 * the package cannot tell what its own import loaded.
 */
const inNode = (script: string): string =>
  execFileSync(process.execPath, ['-e', script], {
    cwd: join(__dirname, '..', '..'),
    encoding: 'utf8',
  }).trim();

describe('entry points', () => {
  it('keeps the main entry free of TypeORM', () => {
    const loaded = inNode(`
      require('./dist/index.js');
      console.log(Object.keys(require.cache).some((path) => path.includes('node_modules/typeorm')));
    `);

    expect(loaded, 'importing the main entry loaded typeorm').toBe('false');
  });

  it('keeps the machine on the main entry', () => {
    // The pure half has to be reachable without the subpath, or the rule above
    // is satisfied by the machine being unusable.
    const exported = inNode(`
      const workflow = require('./dist/index.js');
      console.log(['defineMachine', 'addWorkingDays', 'heldSinceCutoff'].every((name) => name in workflow));
    `);

    expect(exported).toBe('true');
  });

  it('puts the log behind the subpath', () => {
    const exported = inNode(`
      const nestjs = require('./dist/nestjs/index.js');
      console.log(['TransitionLog', 'TransitionLogEntity', 'appendOnlySql'].every((name) => name in nestjs));
    `);

    expect(exported).toBe('true');
  });
});
