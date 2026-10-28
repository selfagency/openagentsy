import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The published packages do not depend on the private adapter.
 *
 * The adapter is the OpenCode plugin: it is a file the CLI copies into a
 * project's plugin directory, and it is never a package on npm. A published
 * package that names it in its dependencies cannot be installed, because the
 * dependency does not resolve, so the check walks the manifests of the
 * workspace and fails when one of them names it.
 *
 * A devDependency is not a dependency. The CLI names the adapter as one,
 * because the plugin file is built from it and copied into the package.
 */
const ADAPTER = '@openagentsy/adapter-opencode';

/** The packages of the workspace, one directory each. */
const packagesRoot = fileURLToPath(new URL('../../', import.meta.url));

/** The manifest of a package, as far as this check reads it. */
type Manifest = {
  name?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

/** Whether a value is a manifest this check can read. */
function isManifest(value: unknown): value is Manifest {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('the published packages', () => {
  it('do not depend on the private adapter', async () => {
    const entries = await readdir(packagesRoot, { withFileTypes: true });
    const offenders: string[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const raw = await readFile(join(packagesRoot, entry.name, 'package.json'), 'utf8').catch(
        () => undefined,
      );
      if (raw === undefined) continue;
      const parsed: unknown = JSON.parse(raw);
      if (!isManifest(parsed)) continue;
      if (parsed.private === true) continue;
      const dependencies = {
        ...parsed.dependencies,
        ...parsed.peerDependencies,
        ...parsed.optionalDependencies,
      };
      const range = dependencies[ADAPTER];
      if (range !== undefined) offenders.push(`${parsed.name ?? entry.name} wants ${range}`);
    }

    expect(offenders).toEqual([]);
  });
});
