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
 * other. The bundle therefore imports `solid-js`, `@opentui/solid`,
 * `@opentui/core`, `@opencode/theme` and `@opencode/plugin` at run time and
 * lets the host resolve them.
 */
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import solidPlugin from '@opentui/solid/bun-plugin';

const outdir = fileURLToPath(new URL('../dist/', import.meta.url));
await rm(outdir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [fileURLToPath(new URL('../src/tui.tsx', import.meta.url))],
  outdir,
  target: 'bun',
  format: 'esm',
  packages: 'external',
  naming: { entry: '[name].[ext]' },
  plugins: [solidPlugin],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

console.log('sidebar: dist/tui.js');
