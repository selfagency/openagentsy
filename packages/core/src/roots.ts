import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * The roots of a project (§3.9).
 *
 * A session has two roots, and they are not the same directory:
 *
 * - the **workspace** is the session's own directory: the worktree, when the
 *   session runs in one. It holds the files the agent edits and the task
 *   files of `.beans/`, which travel with the branch.
 * - the **state root** is the directory that owns the shared OpenAgentsy
 *   state: the board database, the leases, the records, the audit log, the
 *   rungs, the ledger, the lessons, the waivers, the approvals, the memories
 *   and the model lock. In a linked worktree it is the MAIN repository root,
 *   so a builder in a worktree reads the Lead's board and not its own.
 *
 * The two are kept apart on purpose. The lease *store* is the state root's;
 * the lease *matching* is relativised against the session's own workspace,
 * because a path is written where the session is, not where the state is.
 */

/**
 * The model lock file.
 *
 * The name is the one the models package writes (`LOCK_FILE_NAME` there);
 * core cannot import it, because the models package sits above core.
 */
const MODEL_LOCK_FILE = 'openagentsy.models.lock.json';

/**
 * The git variables that point a command at a repository.
 *
 * A git that runs a hook sets these in the environment of the hook, and a
 * command spawned inside that hook inherits them. The child then addresses
 * the repository of the hook instead of the one it was asked about: it
 * writes to the outer index and fights the process that holds the lock —
 * "fatal: Unable to create .../index.lock: File exists" is what that looks
 * like. The child gets these removed, so the repository is the one the
 * caller named.
 */
export const GIT_REPOSITORY_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_PREFIX',
  'GIT_NAMESPACE',
] as const;

/** The environment a git child gets: the caller's, without the git variables. */
export function gitFreeEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const copy: Record<string, string | undefined> = { ...env };
  for (const name of GIT_REPOSITORY_VARS) delete copy[name];
  return copy;
}

/**
 * What git says about the repository a directory is in.
 *
 * The two directories are the same in a plain checkout and different in a
 * linked worktree: the worktree has a git directory of its own under the
 * main repository's, and shares the common one with it.
 */
type GitDirs = {
  /** The directory git keeps this checkout's own data in. */
  gitDir: string;
  /** The directory the repository shares with its worktrees. */
  commonDir: string;
};

/**
 * Ask git about the repository a directory is in.
 *
 * The answer is nothing when the directory is not in a repository, or when
 * git is not installed: a caller that gets nothing falls back to the
 * nearest project root, and a project without a repository is a project
 * like any other.
 */
function gitDirs(cwd: string): GitDirs | undefined {
  const result = spawnSync('git', ['-C', cwd, 'rev-parse', '--git-dir', '--git-common-dir'], {
    encoding: 'utf8',
    env: gitFreeEnv(),
  });
  if (result.error !== undefined || result.status !== 0) return undefined;
  const lines = (result.stdout ?? '')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => line.trim());
  const [gitDir, commonDir] = lines;
  if (gitDir === undefined || commonDir === undefined) return undefined;
  return {
    gitDir: resolve(cwd, gitDir),
    commonDir: resolve(cwd, commonDir),
  };
}

/**
 * The main repository root of a common git directory.
 *
 * The common directory is the `.git` of the main checkout, so the root is
 * the directory that holds it. A common directory that is not named `.git`
 * is the repository directory itself, and that is the root.
 */
function mainRootOf(commonDir: string): string {
  return basename(commonDir) === '.git' ? dirname(commonDir) : commonDir;
}

/**
 * Whether a directory holds the state of an OpenAgentsy project.
 *
 * The model lock is the marker a project always has: it is written into the
 * repository and it travels with it. The state directory is the other
 * marker, and the worktree container under the home directory is named
 * `.openagentsy` too: it holds worktrees and no project, so it does not
 * count.
 */
function isProjectRoot(dir: string): boolean {
  if (existsSync(join(dir, MODEL_LOCK_FILE))) return true;
  const state = join(dir, '.openagentsy');
  if (!existsSync(state)) return false;
  return resolve(state) !== resolve(join(homedir(), '.openagentsy'));
}

/**
 * The nearest directory above a directory that holds a project.
 *
 * The walk stops at the boundary it is given, so a walk inside a
 * repository never leaves it, and at the root of the filesystem. The answer
 * is nothing when nothing holds a project: a project without a board and
 * without a lock is a project whose state has not been created yet, and its
 * own directory is where that state belongs.
 */
function nearestProjectRoot(cwd: string, boundary?: string): string | undefined {
  const start = resolve(cwd);
  let current = start;
  for (;;) {
    if (isProjectRoot(current)) return current;
    if (boundary !== undefined && resolve(current) === resolve(boundary)) return undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * The directory that owns the shared OpenAgentsy state.
 *
 * In a linked worktree this is the MAIN repository root, so a builder in a
 * worktree sees the Lead's board, the Lead's leases and the Lead's records
 * instead of an empty state of its own. Anywhere else it is the nearest
 * project root, which is the directory the state already lives in.
 *
 * The git call runs without the git variables of a hook, so a session that
 * starts inside one asks about its own repository and not the hook's.
 */
export function resolveStateRoot(cwd: string): string {
  const dirs = gitDirs(cwd);
  if (dirs === undefined) return nearestProjectRoot(cwd) ?? resolve(cwd);
  // A linked worktree has a git directory of its own and shares the common
  // one with the main checkout: the state belongs to the main checkout.
  if (dirs.gitDir !== dirs.commonDir) return mainRootOf(dirs.commonDir);
  const main = mainRootOf(dirs.commonDir);
  return nearestProjectRoot(cwd, main) ?? main;
}

/**
 * The two roots of a session.
 */
export type ProjectRoots = {
  /** The session's own directory: the worktree, when the session is in one. */
  workspace: string;
  /** The directory that owns the shared OpenAgentsy state. */
  stateRoot: string;
};

/**
 * The two roots of a session, resolved from the directory it runs in.
 */
export function resolveProjectRoots(cwd: string): ProjectRoots {
  const workspace = resolve(cwd);
  return { workspace, stateRoot: resolveStateRoot(workspace) };
}
