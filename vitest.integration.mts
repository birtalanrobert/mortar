import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Integration tests, separated from unit tests because they need the Docker
 * stack running (`pnpm db:up`).
 *
 * Kept apart deliberately: `pnpm test` must stay fast and runnable anywhere,
 * so nobody is tempted to skip it.
 */
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.integration.test.ts'],
    environment: 'node',
    // Transactions and savepoints are inherently sequential against one
    // database; running them in parallel produces flakes, not speed.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  /**
   * Mandatory for the tests that build a real Nest container.
   *
   * Nest resolves a provider's dependencies from the `design:paramtypes`
   * metadata `emitDecoratorMetadata` produces, and Vitest's default esbuild
   * transform does not emit it. Without this, a container test fails with
   * every dependency `undefined` and an error pointing nowhere near the cause
   * — which is exactly the bug these tests exist to catch.
   */
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
