#!/usr/bin/env bun
/**
 * The sidebar bundle.
 *
 * The Solid JSX transform runs here, through the Bun plugin that
 * `@opentui/solid` ships. The plugin is the documented way to transform
 * Solid JSX with `bun build`, and it is the one the host itself uses, so the
 * two agree on what a JSX element is.
 *
 * The host's packages stay outside the bundle. The host owns the Solid
 * runtime, so a second copy of it inside the plugin would be a second
 * reactive system, and a component rendered in one would not update in the
 * other. The bundle therefore imports `solid-js`, `@opentui/core`,
 * `@opentui/solid` and `@opencode/plugin` at run time and lets the host
 * resolve them.
 *
 * Every other package is bundled. The sidebar reads the board's tables
 * through `@openagentsy/core`, the ledger's through `@openagentsy/ledger`,
 * the tasks through `@openagentsy/tasks` and the lessons through
 * `@openagentsy/hooks`, and the host cannot resolve a workspace package: a
 * plugin is loaded from the OpenCode config directory, where a bare import
 * has nothing to point at. With `packages: 'external'` the bundle was 523
 * bytes and its only import was `@openagentsy/core`; with the list below it
 * stands on its own.
 *
 * The adapter is aliased to its tool module. The `tasks` and `memory`
 * packages reach the adapter for one thing - the helper that turns a tool
 * definition into a host tool - and the adapter's own index re-exports the
 * whole OpenCode plugin, which is 1.29 MiB on its own. Resolving the
 * adapter to `define-tool.ts` alone took the bundle from 1,617.2 KiB to
 * 1,023.7 KiB, and the tool helper is all the sidebar's dependencies use.
 */
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import solidPlugin from '@opentui/solid/bun-plugin';

/** The packages the host owns and resolves. Everything else is bundled. */
const HOST_PACKAGES = ['solid-js', '@opentui/core', '@opentui/solid', '@opencode/plugin'];

/** The adapter's tool helper, without the OpenCode plugin around it. */
const ADAPTER_TOOL = fileURLToPath(
  new URL('../../adapter-opencode/src/define-tool.ts', import.meta.url),
);

/** The plugin that resolves the adapter to its tool module. */
const adapterToolPlugin = {
  name: 'openagentsy-adapter-tool',
  setup(build) {
    build.onResolve({ filter: /^@openagentsy\/adapter-opencode$/ }, () => ({ path: ADAPTER_TOOL }));
  },
};

const outdir = fileURLToPath(new URL('../dist/', import.meta.url));
await rm(outdir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [fileURLToPath(new URL('../src/tui.tsx', import.meta.url))],
  outdir,
  target: 'bun',
  format: 'esm',
  external: HOST_PACKAGES,
  naming: { entry: '[name].[ext]' },
  plugins: [solidPlugin, adapterToolPlugin],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

console.log('sidebar: dist/tui.js');
