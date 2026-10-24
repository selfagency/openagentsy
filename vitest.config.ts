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
    // The unit tests beside it are fast, and they run with everything else.
    exclude: process.env.OPENAGENTSY_EVAL === '1' ? [] : ['packages/evals/src/evals.test.ts'],
    environment: 'node',
    testTimeout: 15_000,
    server: {
      deps: {
        // zod is loaded through Vite rather than as an external dependency.
        // As an external one it resolves to its CommonJS build, where the
        // named export `z` is missing, and every schema call is undefined.
        inline: ['zod'],
      },
    },
  },
});
