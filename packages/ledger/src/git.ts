import { spawnSync } from 'node:child_process';

/**
 * The git commands the scanners run.
 *
 * The scanners are commands and not daemons (§6.4): they read a repository
 * on demand and write what they find into the ledger. Every call here is a
 * read — `git log`, `git show` — and none of them writes to the repository.
 */

/** The separator between the fields of one commit. */
const UNIT = '\u001f';
/** The separator between two commits. */
const RECORD = '\u001e';

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
const GIT_REPOSITORY_VARS = [
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

/** The environment a git child gets: the caller's, without the git variables. */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (GIT_REPOSITORY_VARS.includes(key)) continue;
    env[key] = value;
  }
  return env;
}

/** The result of one git command. */
export type GitResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
};

/**
 * Run a git command and read what it says.
 *
 * The command never throws: a directory that is not a repository, or a git
 * that is not installed, comes back as `ok: false` with the reason, and the
 * scanner treats it as "nothing found" rather than as a crash. A scanner that
 * cannot read a repository must not take the command down with it.
 */
export function runGit(cwd: string, args: string[]): GitResult {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: cleanEnv(),
  });
  if (result.error !== undefined) {
    return { ok: false, stdout: '', stderr: result.error.message };
  }
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** The output of a git command, or null when the command failed. */
export function gitText(cwd: string, args: string[]): string | null {
  const result = runGit(cwd, args);
  return result.ok ? result.stdout : null;
}

/** A commit, as the scanners read it. */
export type GitCommit = {
  /** The full sha. */
  sha: string;
  /** Seconds since the epoch, the way git reports a commit time. */
  at: number;
  /** The whole message, without the format placeholders. */
  message: string;
};

/**
 * The commits of a repository, newest first.
 *
 * `git log` is asked for the sha, the timestamp and the body of the message
 * in one pass. The three are separated by characters that cannot occur in
 * them, so a message with a blank line in it survives the round trip.
 */
export function gitCommits(cwd: string, since: string): GitCommit[] {
  const output = gitText(cwd, [
    'log',
    `--since=${since}`,
    `--format=%H${UNIT}%at${UNIT}%B${RECORD}`,
  ]);
  if (output === null) return [];

  const commits: GitCommit[] = [];
  for (const block of output.split(RECORD)) {
    const trimmed = block.trim();
    if (trimmed.length === 0) continue;
    const parts = trimmed.split(UNIT);
    const sha = parts[0];
    const at = parts[1];
    if (sha === undefined || at === undefined) continue;
    const timestamp = Number(at);
    if (!Number.isFinite(timestamp)) continue;
    commits.push({ sha, at: timestamp, message: parts.slice(2).join(UNIT) });
  }
  return commits;
}

/**
 * The task ids of the `Refs:` trailers of a message.
 *
 * The trailer is the link between a commit and the work it did (§6.5): the
 * pre-commit hook asks for it on an agent commit, and the outcome scanners
 * read it back. A message with no trailer names no task, and a trailer that
 * names nothing is not a trailer.
 */
export function refsTrailers(message: string): string[] {
  const refs: string[] = [];
  for (const line of message.split('\n')) {
    const match = /^\s*Refs:\s*(\S+)\s*$/.exec(line);
    const taskId = match?.[1];
    if (taskId !== undefined) refs.push(taskId);
  }
  return refs;
}
