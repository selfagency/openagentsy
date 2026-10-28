import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        // Point the workspace package at its source so tests never run against a
        // stale build.
        find: '@openagentsy/core',
        replacement: fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      },
      {
        // The Solid client build, not the server build.
        //
        // A Node resolution picks solid-js/dist/server.js, which is the build
        // for rendering on a server: it has no effects, so a Solid component
        // cannot render in it. The OpenTUI reconciler needs the client build,
        // and so does the block that the sidebar renders. The OpenTUI build
        // plugin makes the same redirect when it bundles the plugin, so the
        // test and the shipped bundle agree on which build they run.
        //
        // This is a test-runtime concern only. The built plugin resolves
        // solid-js itself, at the host, and never reads this file.
        find: /^solid-js$/,
        replacement: fileURLToPath(
          new URL('./packages/sidebar/node_modules/solid-js/dist/solid.js', import.meta.url),
        ),
      },
    ],
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
        //
        // The OpenTUI packages are loaded through Vite for the same reason:
        // an external dependency is resolved by the runtime, which would
        // pick a different Solid build for the plugin than for the block,
        // and two Solid builds in one process do not share a context.
        inline: ['zod', 'solid-js', '@opentui/solid', '@opentui/core', '@opencode/plugin'],
      },
    },
  },
});
