import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitFreeEnv } from '@openagentsy/core';
import { describe, expect, it } from 'vitest';

/**
 * The changelog generator.
 *
 * The generator runs in the release workflow, on the branch that is being
 * released, and it writes the file the release notes are cut from. It had
 * one path for the first release and another for every release after it,
 * and the second one took the version from the tag before the release and
 * listed the commits from two releases back. A release with a tag in front
 * of it therefore published the notes of the wrong version.
 *
 * The test builds a repository with releases in it and runs the generator
 * there, because the defect is in how the generator reads the tags.
 */
const script = new URL('./changelog.mjs', import.meta.url).pathname;

const header = '# Changelog\n\nEvery release, from the commits that made it.\n';

/** Git in a directory, with the identity set and the hook environment gone. */
const git = (dir: string, args: string[]): string =>
  execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: gitFreeEnv(),
  });

describe('the changelog generator', () => {
  it('names the version the manifest carries and keeps the older releases', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oa-changelog-'));
    try {
      execFileSync('git', ['init', '--quiet'], { cwd: dir, env: gitFreeEnv() });
      git(dir, ['config', 'user.name', 'the test']);
      git(dir, ['config', 'user.email', 'test@example.com']);
      await writeFile(
        join(dir, 'package.json'),
        `${JSON.stringify({ name: 'x', version: '0.2.0' })}\n`,
      );
      await writeFile(
        join(dir, 'CHANGELOG.md'),
        `${header}\n## Unreleased\n\n### Added\n\n- something that was never released\n\n## 0.1.1 - 2026-10-26\n\n### Added\n\n- the second thing\n\n## 0.1.0 - 2026-10-23\n\n### Added\n\n- the first thing\n`,
      );
      // Two releases are behind this one: the first, and the second. The
      // third commit is the one this release carries.
      git(dir, ['add', '-A']);
      git(dir, ['commit', '-m', 'chore: the first release']);
      git(dir, ['tag', 'v0.1.0']);
      await writeFile(join(dir, 'second.txt'), 'second');
      git(dir, ['add', '-A']);
      git(dir, ['commit', '-m', 'feat(core): the second release']);
      git(dir, ['tag', 'v0.1.1']);
      await writeFile(join(dir, 'third.txt'), 'third');
      git(dir, ['add', '-A']);
      git(dir, ['commit', '-m', 'feat(core): the third thing']);

      execFileSync('bun', [script], { cwd: dir, env: gitFreeEnv() });

      const changelog = await readFile(join(dir, 'CHANGELOG.md'), 'utf8');
      // The version comes from the manifest, not from the tag in front of
      // it: the new section is the first one, and the releases before it
      // are still there.
      const headings = changelog.match(/^## .*$/gm) ?? [];
      expect(headings[0]).toMatch(/^## 0\.2\.0 - \d{4}-\d{2}-\d{2}$/);
      expect(headings).toHaveLength(3);
      // The commits are the ones since the last tag.
      expect(changelog).toContain('the third thing');
      expect(changelog).not.toContain('the second release');
      expect(changelog).not.toContain('the first release');
      // The older releases stay in the file.
      expect(changelog).toContain('## 0.1.1 - 2026-10-26');
      expect(changelog).toContain('## 0.1.0 - 2026-10-23');
      // The unreleased section is replaced by the new one.
      expect(changelog).not.toContain('## Unreleased');
      expect(changelog).not.toContain('something that was never released');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('lists every commit when there is no tag yet', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oa-changelog-'));
    try {
      execFileSync('git', ['init', '--quiet'], { cwd: dir, env: gitFreeEnv() });
      git(dir, ['config', 'user.name', 'the test']);
      git(dir, ['config', 'user.email', 'test@example.com']);
      await writeFile(
        join(dir, 'package.json'),
        `${JSON.stringify({ name: 'x', version: '0.1.0' })}\n`,
      );
      await writeFile(join(dir, 'CHANGELOG.md'), header);
      await writeFile(join(dir, 'first.txt'), 'first');
      git(dir, ['add', '-A']);
      git(dir, ['commit', '-m', 'feat(core): the only thing']);

      execFileSync('bun', [script], { cwd: dir, env: gitFreeEnv() });

      const changelog = await readFile(join(dir, 'CHANGELOG.md'), 'utf8');
      expect(changelog).toContain('## 0.1.0 - ');
      expect(changelog).toContain('the only thing');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
