import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { isLessonId } from '../lessons/id.js';
import { isInside, projectName, worktreeRoot } from '../paths.js';
import {
  EvalArtifact,
  type EvalAssertions,
  type EvalResult,
  type EvalScenario,
  type EvalScenarioResult,
  ProofError,
} from './types.js';

/**
 * The eval runner.
 *
 * A lesson is only worth applying when something shows it works. The proof
 * is an artifact: a list of scenarios, each a command and what it must show.
 * The runner executes them under four rules, and every one of them is a
 * boundary rather than a preference:
 *
 * - the command is an argv, spawned without a shell;
 * - the child sees only PATH, HOME, TMPDIR and the locale, so a token in the
 *   parent's environment never reaches a proof;
 * - the working directory is inside the workspace or an OpenAgentsy worktree,
 *   and it is the real path that has to be inside it;
 * - the process is killed at the timeout.
 *
 * The result holds the verdicts and the hashes. It never holds what a
 * scenario printed, because a result is kept and a printout is not.
 */

/**
 * The environment a proof may see.
 *
 * The list is an allowlist, not a denylist: a variable that is not named
 * here is not in the child's environment at all, so a token that a session
 * happened to hold cannot leak into a proof.
 */
const ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_COLLATE',
  'LC_MESSAGES',
  'LC_NUMERIC',
  'LC_TIME',
] as const;

/**
 * The characters that make a string a shell string.
 *
 * A command that is one element and holds one of these is a shell line that
 * was wrapped in an array, and the runner refuses it rather than run it.
 */
const SHELL_STRING = /[\s;&|<>`$(){}[\]!*?"'\\]/;

/** The most of a run's output the runner keeps, per stream. */
const MAX_CAPTURE_BYTES = 1024 * 1024;

/** The environment a proof gets: the allowlist, and nothing else. */
export function childEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * The command, checked.
 *
 * The schema already holds an array, and this says why: a string is a shell
 * line, and a shell line is a program the runner does not choose.
 */
export function assertArgv(command: unknown): asserts command is string[] {
  if (!Array.isArray(command) || command.length === 0) {
    throw new ProofError(
      'the command must be an argv array',
      'write the program and its arguments as separate elements, never as one shell string',
    );
  }
  for (const part of command) {
    if (typeof part !== 'string' || part.length === 0) {
      throw new ProofError(
        'every element of the command must be a non-empty string',
        'write the program and its arguments as separate elements, never as one shell string',
      );
    }
    if (part.includes('\n')) {
      throw new ProofError(
        'an argument holds a newline',
        'a newline in an argument is a shell line in disguise; pass the argument as one element without it',
      );
    }
  }
  if (command.length === 1 && SHELL_STRING.test(command[0] as string)) {
    throw new ProofError(
      'the command looks like a shell string',
      'write the program and its arguments as separate elements, never as one shell string',
    );
  }
}

/** The hash of a command, so a result can name it without carrying it. */
export function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** The hash of an argv. */
export function commandHash(command: readonly string[]): string {
  return hashOf(JSON.stringify(command));
}

/** What a run produced. */
export type RunOutcome = {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
};

/**
 * Kill the process and everything it started.
 *
 * The child is its own process group, so the group is what dies: a proof that
 * starts a server must not leave the server behind at the timeout.
 */
function killGroup(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill('SIGKILL');
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/**
 * Run one command.
 *
 * The spawn has no shell, the environment is the allowlist, and the timeout
 * kills the group. The output is kept in memory for the assertions and is
 * never written anywhere.
 */
export function runCommand(command: string[], cwd: string, timeoutMs: number): Promise<RunOutcome> {
  assertArgv(command);
  return new Promise((resolveOutcome) => {
    const child = spawn(command[0] as string, command.slice(1), {
      cwd,
      env: childEnv(),
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, timeoutMs);

    const finish = (outcome: RunOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveOutcome(outcome);
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_CAPTURE_BYTES) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_CAPTURE_BYTES) stderr += chunk.toString('utf8');
    });
    child.on('error', (error: Error) => {
      finish({ exitCode: null, timedOut, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on('close', (code: number | null) => {
      finish({ exitCode: code, timedOut, stdout, stderr });
    });
  });
}

/**
 * The verdicts of one scenario.
 *
 * A scenario that only names an exit code does not care what was printed, so
 * only the named assertions are recorded. The spawn itself is always one:
 * a command that could not start has not passed.
 */
export function assertionsOf(scenario: EvalScenario, outcome: RunOutcome): EvalAssertions {
  const assertions: EvalAssertions = {
    spawned: outcome.exitCode !== null || outcome.timedOut,
  };
  const expect = scenario.expect;
  if (expect.exit_code !== undefined) {
    assertions['exit_code'] = outcome.exitCode === expect.exit_code;
  }
  (expect.stdout_includes ?? []).forEach((needle, index) => {
    assertions[`stdout_includes[${index}]`] = outcome.stdout.includes(needle);
  });
  (expect.stdout_excludes ?? []).forEach((needle, index) => {
    assertions[`stdout_excludes[${index}]`] = !outcome.stdout.includes(needle);
  });
  (expect.stderr_includes ?? []).forEach((needle, index) => {
    assertions[`stderr_includes[${index}]`] = outcome.stderr.includes(needle);
  });
  (expect.stderr_excludes ?? []).forEach((needle, index) => {
    assertions[`stderr_excludes[${index}]`] = !outcome.stderr.includes(needle);
  });
  return assertions;
}

/** Whether every assertion held. */
export function allPassed(assertions: EvalAssertions): boolean {
  return Object.values(assertions).every((value) => value === true);
}

/**
 * The directory the results live in.
 */
export function evalResultsDir(stateRoot: string): string {
  return join(stateRoot, '.openagentsy', 'lessons', 'evals');
}

/**
 * The path a result is written to.
 *
 * The lesson id names the file, so it is checked before it names anything:
 * an id that is really a path would write the result outside the directory
 * the results belong in.
 */
export function evalResultPath(stateRoot: string, lessonId: string, at: Date): string {
  if (!isLessonId(lessonId)) {
    throw new ProofError(
      `"${lessonId}" is not a lesson id`,
      'a lesson id looks like oa-lesson-abcd1234',
    );
  }
  const dir = evalResultsDir(stateRoot);
  const stamp = at.toISOString().replace(/[:.]/g, '-');
  const path = join(dir, `${lessonId}-${stamp}.json`);
  if (!isInside(path, [dir])) {
    throw new ProofError(
      'the result path leaves the evaluations directory',
      'a result belongs to the lesson it is about, and the lesson id is not a path',
    );
  }
  return path;
}

/**
 * Refuse a state path that is a symlink.
 *
 * The result is written under the state root, and every part of that path
 * has to be a real directory: a symlinked `.openagentsy` or `lessons` would
 * put the result somewhere else entirely, and the runner cannot know where.
 */
async function assertRealStatePath(stateRoot: string, dir: string): Promise<void> {
  const rest = relative(stateRoot, dir);
  if (rest.startsWith('..')) {
    throw new ProofError(
      'the results directory is not under the state root',
      'a result belongs to the project it was run in',
    );
  }
  const realRoot = await realpath(stateRoot);
  let current = realRoot;
  for (const segment of rest.split('/').filter((part) => part.length > 0)) {
    current = join(current, segment);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(current);
    } catch {
      return;
    }
    if (info.isSymbolicLink()) {
      throw new ProofError(
        `the state path ${current} is a symlink`,
        'the runner refuses to write a result through a symlink',
      );
    }
  }
}

/**
 * Write a result.
 *
 * The mode is 0600, because a result says what a proof did in a project and
 * nobody else has a reason to read it. The file is opened with
 * O_NOFOLLOW, so a symlink at the path is not followed, and with O_EXCL, so
 * an existing file is never replaced: a result is evidence and evidence is
 * not overwritten.
 */
export async function writeEvalResult(
  path: string,
  result: EvalResult,
  stateRoot: string,
): Promise<string> {
  const dir = dirname(path);
  await assertRealStatePath(stateRoot, dir);
  await mkdir(dir, { recursive: true });

  const realRoot = await realpath(stateRoot);
  const realDir = await realpath(dir);
  if (!isInside(realDir, [join(realRoot, '.openagentsy')])) {
    throw new ProofError(
      'the results directory is not inside the state root',
      'the runner refuses to write a result outside the state root',
    );
  }

  let target = path;
  let counter = 1;
  while (await exists(target)) {
    const info = await lstat(target);
    if (info.isSymbolicLink()) {
      throw new ProofError(
        'the result path is a symlink',
        'the runner refuses to write a result through a symlink',
      );
    }
    counter += 1;
    target = path.replace(/\.json$/, '').concat(`-${counter}.json`);
  }
  const handle = await open(
    target,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(result, null, 2)}\n`, 'utf8');
  } finally {
    await handle.close();
  }
  await chmod(target, 0o600);
  return target;
}

/**
 * Whether a path is there.
 */
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check that the verdicts agree with the assertions.
 *
 * The result is recomputed from the assertions and compared with what was
 * recorded. A result that disagrees with its own evidence is not written,
 * because a proof nobody can reconcile is not a proof.
 */
export function assertConsistent(result: EvalResult): void {
  for (const scenario of result.scenarios) {
    if (allPassed(scenario.assertions) !== scenario.passed) {
      throw new ProofError(
        'a scenario verdict disagrees with its assertions',
        'the result was not written; the run and the assertions must be computed the same way',
      );
    }
  }
  if (result.scenarios.every((scenario) => scenario.passed) !== result.passed) {
    throw new ProofError(
      'the run verdict disagrees with the scenario verdicts',
      'the result was not written; the run and the scenarios must be computed the same way',
    );
  }
}

/** What a run needs. */
export type EvalRunOptions = {
  /** The artifact file. */
  artifactPath: string;
  /** The root a working directory may sit in. */
  workspace: string;
  /**
   * The other roots a working directory may sit in.
   *
   * An OpenAgentsy worktree of the same project is one, and so is a
   * temporary worktree the runner made itself.
   */
  allowedRoots?: string[];
  /** The directory a relative working directory resolves against. */
  base?: string;
  /** Where the result is written. The workspace by default. */
  stateRoot?: string;
  /** The lesson the run belongs to. The artifact's own lesson by default. */
  lessonId?: string;
  /** The clock, so a test can pin the moment. */
  now?: () => Date;
};

/**
 * The roots a working directory may sit in.
 *
 * The workspace, the OpenAgentsy worktrees of the same project, and whatever
 * the caller adds.
 */
export function allowedRoots(options: EvalRunOptions): string[] {
  const roots = [options.workspace, worktreeRoot(projectName(options.workspace))];
  return [...roots, ...(options.allowedRoots ?? [])];
}

/**
 * The real path of a root, or the root itself when it is not there.
 */
async function realPathOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/**
 * The working directory of a scenario, checked.
 *
 * A relative one resolves against the base and has to land inside one of the
 * roots. An absolute one has to land inside one of them as well, so a proof
 * cannot ask for `/etc` or for a directory that only looks close.
 *
 * The check is made on the real paths, because a link inside the workspace
 * can point out of it: a scenario that names a link would otherwise run
 * somewhere the workspace does not cover.
 */
export async function resolveScenarioCwd(
  scenario: EvalScenario,
  base: string,
  roots: string[],
): Promise<string> {
  const cwd = isAbsolute(scenario.cwd) ? resolve(scenario.cwd) : resolve(base, scenario.cwd);
  if (!isInside(cwd, roots)) {
    throw new ProofError(
      `the working directory of the scenario ${scenario.id} is outside the workspace`,
      'point the scenario at a directory inside the workspace or an OpenAgentsy worktree',
    );
  }
  let realCwd: string;
  try {
    realCwd = await realpath(cwd);
  } catch {
    throw new ProofError(
      `the working directory of the scenario ${scenario.id} does not exist`,
      'point the scenario at a directory that is there',
    );
  }
  const realRoots = await Promise.all(roots.map(realPathOrSelf));
  if (!isInside(realCwd, realRoots)) {
    throw new ProofError(
      `the working directory of the scenario ${scenario.id} leaves the workspace through a symlink`,
      'point the scenario at a real directory inside the workspace or an OpenAgentsy worktree',
    );
  }
  return realCwd;
}

/**
 * The artifact, read and checked.
 *
 * The schema is the contract: an artifact that does not match it is not a
 * proof, and the issues say what is wrong with it.
 */
function parseArtifact(text: string): EvalArtifact {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch (error) {
    throw new ProofError(
      'the eval artifact is not JSON',
      error instanceof Error ? error.message : 'the proof is malformed',
    );
  }
  const parsed = EvalArtifact.safeParse(parsedJson);
  if (!parsed.success) {
    throw new ProofError(
      'the eval artifact does not match the schema',
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    );
  }
  return parsed.data;
}

/**
 * Run an artifact and write the result.
 *
 * The result is written whatever the verdicts are: a failing run is the
 * evidence that a lesson is not real, and it is worth keeping.
 */
export async function runEvalArtifact(options: EvalRunOptions): Promise<EvalResult> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();

  let text: string;
  try {
    text = await readFile(options.artifactPath, 'utf8');
  } catch (error) {
    throw new ProofError(
      'the eval artifact could not be read',
      error instanceof Error ? error.message : 'the proof is missing',
    );
  }

  const artifact = parseArtifact(text);
  const lessonId = options.lessonId ?? artifact.lesson_id;
  if (!isLessonId(lessonId)) {
    throw new ProofError(
      `"${lessonId}" is not a lesson id`,
      'a lesson id looks like oa-lesson-abcd1234',
    );
  }
  const base = options.base ?? dirname(resolve(options.artifactPath));
  const roots = allowedRoots(options);
  const scenarios: EvalScenarioResult[] = [];

  for (const scenario of artifact.scenarios) {
    const cwd = await resolveScenarioCwd(scenario, base, roots);
    const before = now();
    const outcome = await runCommand(scenario.command, cwd, scenario.timeout_ms);
    const after = now();
    const assertions = assertionsOf(scenario, outcome);
    scenarios.push({
      id: scenario.id,
      phase: scenario.phase,
      command_sha256: commandHash(scenario.command),
      exit_code: outcome.exitCode,
      timed_out: outcome.timedOut,
      duration_ms: Math.max(0, after.getTime() - before.getTime()),
      assertions,
      passed: allPassed(assertions),
    });
  }

  const result: EvalResult = {
    schema_version: '1',
    lesson_id: lessonId,
    artifact_sha256: hashOf(text),
    started_at: startedAt.toISOString(),
    finished_at: now().toISOString(),
    passed: scenarios.every((scenario) => scenario.passed),
    runs: 1,
    scenarios,
  };

  assertConsistent(result);

  const stateRoot = options.stateRoot ?? options.workspace;
  const path = evalResultPath(stateRoot, lessonId, startedAt);
  await writeEvalResult(path, result, stateRoot);
  return result;
}

/**
 * Run a git command and wait for it.
 *
 * The worktree is made with git, so git is run with an argv and with the
 * same narrow environment a proof gets.
 */
async function git(cwd: string, args: string[]): Promise<void> {
  const outcome = await runCommand(['git', ...args], cwd, 60_000);
  if (outcome.exitCode !== 0) {
    throw new ProofError(
      `git ${args[0] ?? ''} failed`,
      outcome.stderr.trim() === '' ? 'the worktree could not be made' : outcome.stderr.trim(),
    );
  }
}

/**
 * Take the worktree and the directory it was made in back.
 *
 * A cleanup that fails is reported, because a directory left behind holds a
 * whole checkout of the project.
 */
async function removeWorktree(
  repo: string,
  worktree: string,
  dir: string,
  added: boolean,
): Promise<string | undefined> {
  const problems: string[] = [];
  if (added) {
    try {
      await git(repo, ['worktree', 'remove', '--force', worktree]);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  return problems.length === 0 ? undefined : problems.join('; ');
}

/**
 * A temporary worktree, and what to do in it.
 *
 * The worktree is where the candidate change is applied: the baseline
 * scenario has to fail on the current owner and pass with the change, and
 * the change lives in a commit, so the commit is checked out apart from the
 * tree that is being worked in.
 *
 * The directory is made before the worktree is added, so the cleanup has to
 * run whether the add worked or not: a directory left behind holds a
 * checkout of the project.
 */
export async function withTemporaryWorktree<T>(options: {
  repo: string;
  ref: string;
  run: (worktree: string) => Promise<T>;
}): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'openagentsy-lesson-'));
  const worktree = join(dir, 'worktree');
  let added = false;
  let cleaned = false;
  const cleanup = async (): Promise<string | undefined> => {
    if (cleaned) return undefined;
    cleaned = true;
    return removeWorktree(options.repo, worktree, dir, added);
  };
  try {
    await git(options.repo, ['worktree', 'add', '--detach', worktree, options.ref]);
    added = true;
    const result = await options.run(worktree);
    const problem = await cleanup();
    if (problem !== undefined) {
      throw new ProofError(
        'the temporary worktree could not be removed',
        `the directory ${dir} is still there: ${problem}`,
      );
    }
    return result;
  } catch (error) {
    const problem = await cleanup();
    const message = error instanceof Error ? error.message : String(error);
    if (problem !== undefined) {
      throw new ProofError(
        message,
        `the temporary worktree could not be removed either: ${problem}`,
      );
    }
    throw error instanceof Error ? error : new Error(message);
  }
}

/** What the reproduction found. */
export type BaselineOutcome = {
  /** Whether the baseline scenario failed on the current owner. */
  baseline_failed: boolean;
  /** Whether the same scenario passed with the change applied. */
  with_change_passed: boolean;
  /** Whether the proof holds. */
  passed: boolean;
  /** Why the baseline could not be reproduced, when it could not. */
  reason?: string;
  /** The run on the current owner, before the change. */
  before?: EvalResult;
  /** The run with the change applied, in the temporary worktree. */
  after?: EvalResult;
};

/**
 * Reproduce the baseline.
 *
 * The baseline scenario has to fail on the current owner and pass with the
 * change applied in a temporary worktree. A baseline that passes on the
 * current owner proves nothing: the behaviour was already there.
 */
export async function reproduceBaseline(options: {
  artifactPath: string;
  workspace: string;
  repo: string;
  changeRef: string;
  lessonId?: string;
  now?: () => Date;
}): Promise<BaselineOutcome> {
  const text = await readFile(options.artifactPath, 'utf8');
  const artifact = parseArtifact(text);
  const baselines = artifact.scenarios.filter((scenario) => scenario.phase === 'baseline');
  if (baselines.length === 0) {
    return {
      baseline_failed: false,
      with_change_passed: false,
      passed: false,
      reason: 'the artifact has no baseline scenario, so the baseline cannot be reproduced',
    };
  }

  const before = await runEvalArtifact({
    artifactPath: options.artifactPath,
    workspace: options.workspace,
    ...(options.lessonId === undefined ? {} : { lessonId: options.lessonId }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const baselineFailed = before.scenarios
    .filter((scenario) => scenario.phase === 'baseline')
    .every((scenario) => !scenario.passed);

  const withChange = await withTemporaryWorktree({
    repo: options.repo,
    ref: options.changeRef,
    run: async (worktree) =>
      runEvalArtifact({
        artifactPath: options.artifactPath,
        workspace: options.workspace,
        base: worktree,
        allowedRoots: [worktree],
        ...(options.lessonId === undefined ? {} : { lessonId: options.lessonId }),
        ...(options.now === undefined ? {} : { now: options.now }),
      }),
  });
  const changePassed = withChange.scenarios
    .filter((scenario) => scenario.phase === 'baseline')
    .every((scenario) => scenario.passed);

  return {
    baseline_failed: baselineFailed,
    with_change_passed: changePassed,
    passed: baselineFailed && changePassed,
    before,
    after: withChange,
  };
}
