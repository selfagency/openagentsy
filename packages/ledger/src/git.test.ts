import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runGit } from './git.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openagentsy-git-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * The variables that point a git command at a repository.
 *
 * A git that runs a hook sets them in the environment of the hook, and a
 * command spawned inside that hook inherits them. The runner has to take
 * them away, or the child writes to the repository of the hook.
 */
const REPOSITORY_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_PREFIX',
  'GIT_NAMESPACE',
];

/** The environment as it was before the test touched it. */
const saved = new Map<string, string | undefined>();

function setVar(name: string, value: string): void {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  process.env[name] = value;
}

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
});

/** A repository with one commit in it. */
async function seedRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'openagentsy-repo-'));
  const git = (...args: string[]): void => {
    const result = runGit(repo, [
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=Test',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ]);
    if (!result.ok) throw new Error(result.stderr);
  };
  git('init', '-q');
  await writeFile(join(repo, 'a.txt'), 'one\n');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'feat: add');
  return repo;
}

describe('the git runner', () => {
  it('takes the repository variables away from the child', async () => {
    const repo = await seedRepo();
    for (const name of REPOSITORY_VARS) setVar(name, `oa-sentinel-${name}`);

    // A git alias that is a shell command runs in the environment of the
    // child, so it shows what the child was given.
    const dumped = runGit(repo, ['-c', 'alias.dumpenv=!env', 'dumpenv']);

    expect(dumped.ok).toBe(true);
    expect(dumped.stdout).not.toContain('oa-sentinel');
    // Git sets a few of its own for the alias it runs; the ones it does
    // not set have to be gone from the child entirely.
    for (const name of REPOSITORY_VARS.filter((entry) => entry !== 'GIT_PREFIX')) {
      expect(dumped.stdout).not.toContain(`${name}=`);
    }
    expect(dumped.stdout).toContain('PATH=');
  });

  it('reads the repository the caller named, not the one the environment names', async () => {
    const repo = await seedRepo();
    for (const name of REPOSITORY_VARS) setVar(name, '/nonexistent');

    const result = runGit(repo, ['log', '--oneline']);

    expect(result.ok).toBe(true);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('feat: add');
  });

  it('says what went wrong instead of throwing', async () => {
    const result = runGit(root, ['not-a-command']);

    expect(result.ok).toBe(false);
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});
