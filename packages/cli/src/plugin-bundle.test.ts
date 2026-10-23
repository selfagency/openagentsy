import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The plugin bundle has to stand on its own.
 *
 * The plugin is loaded by OpenCode from a project's plugin directory, where
 * bare imports do not resolve, so it travels as one file. A dynamic import
 * that the bundler leaves as a chunk produces a second file that the copy
 * does not take, and the plugin then fails to load at the worst possible
 * moment: the lease guard never registers and every write goes through.
 *
 * Nothing else in the test suite loads the bundle, so this is the one place
 * that can see it.
 */
const bundlePath = fileURLToPath(new URL('../plugin/openagentsy.js', import.meta.url));

describe('the plugin bundle', () => {
  it('imports nothing from a path next to it', async () => {
    const bundle = await readFile(bundlePath, 'utf8');
    const relative = bundle.match(/(?:from|import\()\s*['"]\.[^'"]+['"]/g);
    expect(relative ?? []).toEqual([]);
  });

  it('is the file the setup command copies out', async () => {
    const source = await readFile(
      fileURLToPath(new URL('../../adapter-opencode/dist/index.js', import.meta.url)),
      'utf8',
    );
    const bundle = await readFile(bundlePath, 'utf8');
    expect(bundle).toBe(source);
  });
});
