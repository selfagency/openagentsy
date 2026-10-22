import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Point the workspace package at its source so tests never run against a
      // stale build.
      '@openagentsy/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    // The safety suite runs real agents, so it only runs when it is asked for.
    exclude: process.env.OPENAGENTSY_EVAL === '1' ? [] : ['packages/evals/**'],
    environment: 'node',
    testTimeout: 15_000,
  },
});
