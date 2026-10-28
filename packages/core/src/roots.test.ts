import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitFreeEnv, resolveStateRoot } from './roots.js';

/**
 * A temporary directory under its real name.
 *
 * The system temporary directory is a symlink on this machine, and git
 * reports the real path of a repository while `mkdtemp` reports the
 * symlinked one. The state root is one directory under one name, so the
 * fixture starts from the name the resolver answers with.
 */
async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

/**
 * A git repository with a linked worktree beside it.
 *
 * The two directories are the whole point of the section: the worktree has
 * a git directory of its own and shares the common one with the main
 * checkout, and the state of a project belongs to the main checkout.
 */
async function repositoryWithWorktree(): Promise<{ main: string; worktree: string }> {
  const base = await tempDir('openagentsy-roots-');
  const main = join(base, 'main');
  const worktree = join(base, 'wt');
  await mkdir(main, { recursive: true });

  const git = (args: string[], cwd: string): void => {
    execFileSync('git', args, {
      cwd,
      env: gitFreeEnv(),
      stdio: 'ignore',
    });
  };

  git(['init', '-q'], main);
  git(['config', 'user.email', 'test@openagentsy.test'], main);
  git(['config', 'user.name', 'test'], main);
  // The machine's global config turns the fsmonitor on, and a repository
  // whose daemon is not running then answers "could not read IPC response"
  // to the commands that read the index. The global config also signs every
  // commit, and the signing agent of the machine is not available to a test.
  git(['config', 'core.fsmonitor', 'false'], main);
  git(['config', 'commit.gpgsign', 'false'], main);
  await writeFile(join(main, 'openagentsy.models.lock.json'), '{}\n', 'utf8');
  git(['add', '-A'], main);
  git(['commit', '-q', '-m', 'seed'], main);
  git(['worktree', 'add', '-q', '-b', 'feature/x', worktree], main);

  return { main, worktree };
}

describe('resolveStateRoot', () => {
  it('answers the main repository root for the main checkout', async () => {
    const { main } = await repositoryWithWorktree();
    expect(resolveStateRoot(main)).toBe(main);
  });

  it('answers the main repository root for a linked worktree', async () => {
    // The plan's own case: a builder rooted in a worktree must see the
    // Lead's state, not a state of its own.
    const { main, worktree } = await repositoryWithWorktree();
    expect(resolveStateRoot(worktree)).toBe(main);
  });

  it('answers the main repository root from a subdirectory of a worktree', async () => {
    const { main, worktree } = await repositoryWithWorktree();
    const nested = join(worktree, 'packages', 'core');
    await mkdir(nested, { recursive: true });
    expect(resolveStateRoot(nested)).toBe(main);
  });

  it('answers the main repository root from a subdirectory of the checkout', async () => {
    const { main } = await repositoryWithWorktree();
    const nested = join(main, 'packages', 'core');
    await mkdir(nested, { recursive: true });
    expect(resolveStateRoot(nested)).toBe(main);
  });

  it('does not inherit the git environment of a hook', async () => {
    // A git that runs a hook sets these, and a child that inherits them
    // addresses the repository of the hook instead of the one it was asked
    // about. The answer has to be the worktree's own main repository.
    const { main, worktree } = await repositoryWithWorktree();
    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = join(main, '.git');
    try {
      expect(resolveStateRoot(worktree)).toBe(main);
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
    }
  });

  it('answers the directory that holds the state when there is no repository', async () => {
    const root = await tempDir('openagentsy-plain-');
    await mkdir(join(root, '.openagentsy'), { recursive: true });
    expect(resolveStateRoot(root)).toBe(root);
  });

  it('answers the directory that holds the model lock when there is no repository', async () => {
    const root = await tempDir('openagentsy-plain-');
    await writeFile(join(root, 'openagentsy.models.lock.json'), '{}\n', 'utf8');
    expect(resolveStateRoot(root)).toBe(root);
  });

  it('answers the directory it was given when nothing holds a project', async () => {
    const root = await tempDir('openagentsy-plain-');
    expect(resolveStateRoot(root)).toBe(root);
  });
});
