import { copyFile, mkdir, readFile } from 'node:fs/promises';
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

/**
 * The bundle has to stand on its own, and a chunk would break it quietly.
 *
 * A dynamic import that the bundler leaves as a chunk produces a second
 * file next to the bundle, and the copy takes only the first. The plugin
 * then fails to load, the lease guard never registers, and every write goes
 * through. That is the worst failure this project has, and it happened
 * once, so the build says so instead of shipping it.
 */
const bundle = await readFile(target, 'utf8');
const relative = bundle.match(/(?:from|import\()\s*['"]\.[^'"]+['"]/g);
if (relative !== null) {
  throw new Error(
    `the plugin bundle is not self contained: it imports ${relative.length} relative path(s) ` +
      `(for example ${relative[0]}). The plugin is copied out as one file, so a dynamic ` +
      'import has to be inlined. Set inlineDynamicImports in the tsdown config.',
  );
}

console.log(`the plugin bundle is in ${target}`);
