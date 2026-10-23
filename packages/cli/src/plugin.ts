import { copyFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where the plugin bundle lives.
 *
 * The bundle is two things at once: the file the OpenCode plugin loader
 * reads, and the copy the published package ships. In a checkout it is built
 * by the adapter package; in an installed package it sits next to this file.
 * The first place that has one wins.
 */
const CANDIDATES = [
  // An installed package: the bundle is shipped in the plugin directory.
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'openagentsy.js'),
  // A checkout: the adapter package builds it.
  resolve(process.cwd(), 'packages', 'adapter-opencode', 'dist', 'index.js'),
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'adapter-opencode',
    'dist',
    'index.js',
  ),
];

/** The plugin bundle, or undefined when it has not been built. */
export async function findPluginBundle(): Promise<string | undefined> {
  for (const candidate of CANDIDATES) {
    if (
      await stat(candidate).then(
        () => true,
        () => false,
      )
    ) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Install the plugin into a project's OpenCode plugin directory.
 *
 * The plugin is a self contained bundle, because a plugin file is loaded from
 * the config directory where bare imports do not resolve, and the plugin
 * runtime has no sqlite module.
 */
export async function installPlugin(root: string, dryRun: boolean): Promise<string | undefined> {
  const source = await findPluginBundle();
  if (source === undefined) return undefined;

  const target = join(root, '.opencode', 'plugins', 'openagentsy.js');
  if (!dryRun) {
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  return target;
}
