import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Ship the plugin bundle with the CLI.
 *
 * The plugin is loaded by OpenCode from a project's plugin directory, where
 * bare imports do not resolve, so it is one self contained file. A user who
 * installs the CLI from npm has no checkout, so the bundle travels inside
 * the package and the setup command copies it out.
 */
const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '..', '..', 'adapter-opencode', 'dist', 'index.js');
const target = join(here, '..', 'plugin', 'openagentsy.js');

await mkdir(dirname(target), { recursive: true });
await copyFile(source, target);
console.log(`the plugin bundle is in ${target}`);
