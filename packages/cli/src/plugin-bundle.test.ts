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
    // The statements that pull in a relative path, and nothing else. The
    // bundle carries the text of the packages it inlines, and a doc comment
    // in one of them shows an import of its own; a statement that does not
    // start a line is prose, not an import.
    const relative = bundle.match(
      /^(?!\s*\*)\s*(?:(?:import|export)[^\n;]*?from|import\s*\()\s*['"]\.[^'"]+['"]/gm,
    );
    expect(relative ?? []).toEqual([]);
  });

  it('does not carry the TypeScript compiler', async () => {
    const bundle = await readFile(bundlePath, 'utf8');
    // The comment rules need a TypeScript parse to find the comments of a
    // file. The plugin runs a check on every write, so the compiler is not
    // in the bundle: the comment lint runs in the quality tool and in the
    // audit command, where a parse is paid for on demand. These are names
    // of the compiler's own API, and nothing else in the bundle has them.
    expect(bundle).not.toContain('getPreEmitDiagnostics');
    expect(bundle).not.toContain('createTypeChecker');
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
