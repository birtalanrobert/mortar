import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/*/src/**/*.test.ts', 'packages/*/src/**/index.ts'],
    },
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
