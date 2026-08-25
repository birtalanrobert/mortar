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
});
