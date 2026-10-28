import { defineConfig } from 'tsdown';

/**
 * The plugin is loaded from the OpenCode config directory, where bare
 * imports do not resolve. The bundle has to stand on its own, so zod, the
 * core package and the ledger are inlined and the output has no external
 * dependency.
 *
 * The hooks package is named with a pattern as well, because the adapter
 * reaches its modules by their own path. A name without the pattern is left
 * external, and a plugin that imports a package the machine does not have
 * fails to load at the worst possible moment.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: false,
  clean: true,
  noExternal: [
    'zod',
    '@openagentsy/core',
    '@openagentsy/hooks',
    /^@openagentsy\/hooks\/.+$/,
    '@openagentsy/ledger',
    '@openagentsy/memory',
    '@openagentsy/tasks',
  ],
  outputOptions: {
    minify: false,
    // The bundle is copied out as one file, so a dynamic import has to be
    // inlined too. A chunk would be a second file the copy does not take,
    // and the plugin would fail to load at the worst possible moment.
    inlineDynamicImports: true,
  },
});
