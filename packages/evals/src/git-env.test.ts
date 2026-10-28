import { execFile } from 'node:child_process';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { seedCase } from './fixture.js';
import { GIT_REPOSITORY_VARS, gitFreeEnv } from './git-env.js';

const execFileAsync = promisify(execFile);

describe('gitFreeEnv', () => {
  it('takes the git variables out and keeps the rest', () => {
    const env = gitFreeEnv({
      PATH: '/usr/bin',
      HOME: '/home/x',
      GIT_DIR: '/outer/.git',
      GIT_WORK_TREE: '/outer',
      GIT_INDEX_FILE: '/outer/.git/index',
    });

    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/x');
    for (const name of GIT_REPOSITORY_VARS) {
      expect(env[name]).toBeUndefined();
    }
  });
});

describe('seedCase', () => {
  it('seeds the case own repository when a git directory is inherited', async () => {
    // The measured shape (2026-10-27): the suite ran from a commit, so the
    // hook's git variables were in the environment, and the case's git
    // commands wrote into the repository that started the suite. The case
    // repository is the one that must be written.
    const outer = await mkdtemp(join(tmpdir(), 'oa-outer-repo-'));
    // The test's own git commands get the clean environment too: a git that
    // inherits the variables would set up the wrong repository, which is
    // the failure this test is about.
    await execFileAsync('git', ['init', '-q'], { cwd: outer, env: gitFreeEnv() });
    const outerConfigBefore = await readFile(join(outer, '.git', 'config'), 'utf8');

    const caseRoot = await mkdtemp(join(tmpdir(), 'oa-case-repo-'));
    const before = process.env.GIT_DIR;
    process.env.GIT_DIR = join(outer, '.git');
    try {
      await seedCase(caseRoot, { files: { 'hello.txt': 'one line\n' } }, { repoRoot: outer });
    } finally {
      if (before === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = before;
    }

    // The case has its own repository, with the seed commit in it.
    const caseGit = await stat(join(caseRoot, '.git'));
    expect(caseGit.isDirectory()).toBe(true);
    const { stdout: log } = await execFileAsync('git', ['--no-pager', 'log', '--oneline'], {
      cwd: caseRoot,
      env: gitFreeEnv(),
    });
    expect(log).toContain('seed');

    // The repository that was inherited is untouched: no commit, no config.
    const { stdout: outerCount } = await execFileAsync('git', ['rev-list', '--count', '--all'], {
      cwd: outer,
      env: gitFreeEnv(),
    });
    expect(outerCount.trim()).toBe('0');
    expect(await readFile(join(outer, '.git', 'config'), 'utf8')).toBe(outerConfigBefore);
  });
});
