import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as browser from './index';
import * as root from '../index';

const SRC = resolve(__dirname, '..');
const IMPORT = /(?:^|\n)\s*(?:import|export)[\s\S]{0,400}?from\s*['"]([^'"]+)['"]/g;

/** Every module of this package reachable from an entry, by its path under `src/`. */
function reachable(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    for (const [, specifier] of source.matchAll(IMPORT)) {
      if (!specifier!.startsWith('.')) continue;
      const target = resolve(dirname(file), specifier!);
      queue.push(`${target}.ts`, join(target, 'index.ts'));
    }
  }
  return [...seen].map((file) => relative(SRC, file));
}

describe('the browser entry', () => {
  it('reaches nothing of the server, nor of Nest', () => {
    const modules = reachable(join(SRC, 'browser/index.ts'));

    expect(modules).toEqual(
      expect.arrayContaining(['browser/index.ts', 'wire.ts', 'gaps.ts', 'client.ts']),
    );
    expect(modules.filter((file) => /^(server|nestjs)\//.test(file))).toEqual([]);
  });

  it('is the root without the server: the same client, wire format and gap logic', () => {
    expect(Object.keys(browser).sort()).toEqual([
      'ChannelCursor',
      'RealtimeClient',
      'missing',
      'parseFrame',
    ]);
    expect(browser.RealtimeClient).toBe(root.RealtimeClient);
    expect(browser.ChannelCursor).toBe(root.ChannelCursor);
  });
});
