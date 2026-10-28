import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The staging of a package for the publish.
 *
 * The publish has to happen outside the repository tree, because npm
 * refuses to run in a tree whose root asks for another package manager,
 * and this repository's root asks for bun. A copy outside the tree has no
 * root above it, and the copy's manifest has to carry the versions the
 * workspace protocol named, because npm cannot resolve a workspace range
 * outside the workspace.
 */
const script = new URL('./stage-package.mjs', import.meta.url).pathname;

describe('the package staging', () => {
  it('writes the workspace ranges out as the versions they name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oa-stage-'));
    try {
      // A workspace with two packages, and a third that depends on both.
      const root = join(dir, 'workspace');
      await mkdir(join(root, 'packages', 'core'), { recursive: true });
      await mkdir(join(root, 'packages', 'tools'), { recursive: true });
      await mkdir(join(root, 'packages', 'app'), { recursive: true });
      await writeFile(
        join(root, 'packages', 'core', 'package.json'),
        `${JSON.stringify({ name: '@x/core', version: '1.2.3' })}\n`,
      );
      await writeFile(
        join(root, 'packages', 'tools', 'package.json'),
        `${JSON.stringify({ name: '@x/tools', version: '0.4.5' })}\n`,
      );
      await writeFile(
        join(root, 'packages', 'app', 'package.json'),
        `${JSON.stringify({
          name: '@x/app',
          version: '2.0.0',
          dependencies: { '@x/core': 'workspace:^', '@x/tools': 'workspace:*' },
          devDependencies: { '@x/tools': 'workspace:^' },
        })}\n`,
      );
      await mkdir(join(root, 'packages', 'app', 'node_modules', 'left'), {
        recursive: true,
      });
      await writeFile(join(root, 'packages', 'app', 'node_modules', 'left', 'x'), 'x');

      const stage = join(dir, 'stage');
      execFileSync('bun', [script, join(root, 'packages', 'app'), stage, root]);

      const staged = JSON.parse(await readFile(join(stage, 'package.json'), 'utf8'));
      expect(staged.dependencies['@x/core']).toBe('^1.2.3');
      expect(staged.dependencies['@x/tools']).toBe('0.4.5');
      expect(staged.devDependencies['@x/tools']).toBe('^0.4.5');
      // The copy carries the package, not its dependencies.
      expect(existsSync(join(stage, 'node_modules'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
