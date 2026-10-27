import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertArgv,
  evalResultPath,
  gitCommand,
  reproduceBaseline,
  runCommand,
  runEvalArtifact,
  withTemporaryWorktree,
} from './runner.js';

/** The moment every result in this file carries, so the path is known. */
const PINNED = new Date('2026-10-27T12:00:00.000Z');

/** The lesson every artifact here belongs to. */
const LESSON = 'oa-lesson-test0001';

async function workspace(): Promise<{ root: string; remove: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'openagentsy-eval-'));
  return { root, remove: () => rm(root, { recursive: true, force: true }) };
}

/** An artifact file with the scenarios it is given. */
async function artifactFile(root: string, scenarios: unknown[]): Promise<string> {
  const path = join(root, 'artifact.json');
  await writeFile(
    path,
    JSON.stringify(
      { schema_version: '1', lesson_id: LESSON, name: 'the proof', scenarios },
      null,
      2,
    ),
    'utf8',
  );
  return path;
}

/** A script the scenarios run, so no shell is involved. */
async function script(root: string, name: string, body: string): Promise<string> {
  const path = join(root, name);
  await writeFile(path, body, 'utf8');
  return path;
}

/** Whether a path is there. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * A throwaway repository, with the change in the commit on top.
 *
 * The change lives in the second commit, so the worktree can be made from it
 * and the baseline can be run on the tree without it. Every git command goes
 * through the runner's own builder, because the runner's environment cannot
 * reach a signing agent and a throwaway commit must not need one.
 */
async function throwawayRepo(root: string): Promise<{ ref: string; owner: string }> {
  await runCommand(gitCommand(['init', '-q']), root, 30_000);
  await writeFile(join(root, 'answer.txt'), 'wrong\n', 'utf8');
  await runCommand(gitCommand(['add', '.']), root, 30_000);
  await commitIn(root, 'init');
  await writeFile(join(root, 'answer.txt'), 'right\n', 'utf8');
  await runCommand(gitCommand(['add', '.']), root, 30_000);
  await commitIn(root, 'the change');
  const ref = (await runCommand(gitCommand(['rev-parse', 'HEAD']), root, 30_000)).stdout.trim();
  const owner = (await runCommand(gitCommand(['rev-parse', 'HEAD~1']), root, 30_000)).stdout.trim();
  await runCommand(gitCommand(['checkout', owner]), root, 30_000);
  return { ref, owner };
}

/** A commit in the throwaway repository, with an identity of its own. */
async function commitIn(root: string, message: string): Promise<void> {
  const outcome = await runCommand(
    gitCommand([
      '-c',
      'user.email=builder@example.com',
      '-c',
      'user.name=Builder',
      'commit',
      '-q',
      '-m',
      message,
    ]),
    root,
    30_000,
  );
  if (outcome.exitCode !== 0) {
    throw new Error(`the throwaway commit failed: ${outcome.stderr.trim()}`);
  }
}

/** The artifact with the baseline and the candidate scenario. */
async function baselineArtifact(root: string): Promise<string> {
  return artifactFile(root, [
    {
      id: 'baseline',
      phase: 'baseline',
      cwd: '.',
      command: ['cat', 'answer.txt'],
      expect: { stdout_includes: ['right'] },
    },
    {
      id: 'candidate',
      phase: 'candidate',
      cwd: '.',
      command: ['cat', 'answer.txt'],
      expect: { stdout_includes: ['right'] },
    },
  ]);
}

/**
 * A home directory whose git config signs every commit.
 *
 * The machine may sign with an agent the runner's environment cannot reach,
 * and the signer here fails the way a locked agent fails. The marker says
 * the signer was reached at all.
 */
async function signingHome(): Promise<{
  home: string;
  marker: string;
  remove: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'openagentsy-signing-home-'));
  const marker = join(root, 'the-signer-was-called');
  const signer = join(root, 'signer');
  await writeFile(
    signer,
    ['#!/bin/sh', `printf 'called\\n' > "${marker}"`, 'exit 1', ''].join('\n'),
    'utf8',
  );
  await chmod(signer, 0o755);
  await writeFile(
    join(root, '.gitconfig'),
    [
      '[commit]',
      '\tgpgsign = true',
      '[gpg]',
      '\tformat = ssh',
      '[gpg "ssh"]',
      `\tprogram = ${signer}`,
      '[user]',
      '\tsigningkey = ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFIXTUREKEYFORTHEEVALRUNNERONLY0000000',
      '',
    ].join('\n'),
    'utf8',
  );
  return { home: root, marker, remove: () => rm(root, { recursive: true, force: true }) };
}

describe('the command', () => {
  it('rejects a shell string', () => {
    expect(() => assertArgv('cat answer.txt')).toThrow(/argv/);
  });

  it('rejects a shell line wrapped in an array', () => {
    expect(() => assertArgv(['cat answer.txt; rm -rf /'])).toThrow(/shell string/);
  });

  it('rejects an empty command', () => {
    expect(() => assertArgv([])).toThrow(/argv/);
  });

  it('rejects an argument with a newline', () => {
    expect(() => assertArgv(['cat', 'a\nb'])).toThrow(/newline/);
  });

  it('takes an argv', () => {
    expect(() => assertArgv(['cat', 'answer.txt'])).not.toThrow();
  });
});

describe('the runner', () => {
  it('rejects an artifact whose command is a shell string', async () => {
    const { root, remove } = await workspace();
    try {
      const path = await artifactFile(root, [
        { id: 's', phase: 'candidate', cwd: '.', command: 'cat answer.txt', expect: {} },
      ]);
      await expect(
        runEvalArtifact({ artifactPath: path, workspace: root, now: () => PINNED }),
      ).rejects.toThrow(/does not match the schema/);
    } finally {
      await remove();
    }
  });

  it('rejects a working directory outside the workspace', async () => {
    const { root, remove } = await workspace();
    try {
      const path = await artifactFile(root, [
        { id: 's', phase: 'candidate', cwd: '../../etc', command: ['cat', 'x'], expect: {} },
      ]);
      await expect(
        runEvalArtifact({ artifactPath: path, workspace: root, now: () => PINNED }),
      ).rejects.toThrow(/outside the workspace/);
    } finally {
      await remove();
    }
  });

  it('rejects a timeout over the maximum', async () => {
    const { root, remove } = await workspace();
    try {
      const path = await artifactFile(root, [
        {
          id: 's',
          phase: 'candidate',
          cwd: '.',
          command: ['cat', 'x'],
          timeout_ms: 400_000,
          expect: {},
        },
      ]);
      await expect(
        runEvalArtifact({ artifactPath: path, workspace: root, now: () => PINNED }),
      ).rejects.toThrow(/does not match the schema/);
    } finally {
      await remove();
    }
  });

  it('rejects a symlinked result path', async () => {
    const { root, remove } = await workspace();
    try {
      const path = await artifactFile(root, [
        { id: 's', phase: 'candidate', cwd: '.', command: ['cat', 'x'], expect: {} },
      ]);
      const target = evalResultPath(root, LESSON, PINNED);
      await mkdir(dirname(target), { recursive: true });
      await symlink(join(root, 'somewhere-else.json'), target);
      await expect(
        runEvalArtifact({ artifactPath: path, workspace: root, now: () => PINNED }),
      ).rejects.toThrow(/symlink/);
    } finally {
      await remove();
    }
  });

  it('never writes stdout or stderr into the result', async () => {
    const { root, remove } = await workspace();
    try {
      const marker = 'THE-MARKER-9431';
      const printer = await script(
        root,
        'print.js',
        `console.log(${JSON.stringify(marker)});console.error(${JSON.stringify(marker)});\n`,
      );
      const path = await artifactFile(root, [
        {
          id: 's',
          phase: 'candidate',
          cwd: '.',
          command: [process.execPath, printer],
          expect: { stdout_includes: [marker], stderr_includes: [marker] },
        },
      ]);
      const result = await runEvalArtifact({
        artifactPath: path,
        workspace: root,
        now: () => PINNED,
      });
      expect(result.passed).toBe(true);
      expect(JSON.stringify(result)).not.toContain(marker);
      const written = await readFile(evalResultPath(root, LESSON, PINNED), 'utf8');
      expect(written).not.toContain(marker);
    } finally {
      await remove();
    }
  });

  it('strips a fake GITHUB_TOKEN from the child environment', async () => {
    const { root, remove } = await workspace();
    const before = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = ['gh', 'p_', 'a'.repeat(36)].join('');
    try {
      const path = await artifactFile(root, [
        {
          id: 's',
          phase: 'candidate',
          cwd: '.',
          command: ['printenv', 'GITHUB_TOKEN'],
          expect: { exit_code: 1 },
        },
      ]);
      const result = await runEvalArtifact({
        artifactPath: path,
        workspace: root,
        now: () => PINNED,
      });
      expect(result.passed).toBe(true);
      expect(result.scenarios[0]?.exit_code).toBe(1);
    } finally {
      if (before === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = before;
      await remove();
    }
  });

  it('writes the result with mode 0600', async () => {
    const { root, remove } = await workspace();
    try {
      const path = await artifactFile(root, [
        { id: 's', phase: 'candidate', cwd: '.', command: ['cat', 'x'], expect: {} },
      ]);
      await runEvalArtifact({ artifactPath: path, workspace: root, now: () => PINNED });
      const info = await stat(evalResultPath(root, LESSON, PINNED));
      expect(info.mode & 0o777).toBe(0o600);
    } finally {
      await remove();
    }
  });

  it('kills the process at the timeout', async () => {
    const { root, remove } = await workspace();
    try {
      const sleeper = await script(root, 'sleep.js', 'setTimeout(() => {}, 60000);\n');
      const path = await artifactFile(root, [
        {
          id: 's',
          phase: 'candidate',
          cwd: '.',
          command: [process.execPath, sleeper],
          timeout_ms: 300,
          expect: {},
        },
      ]);
      const result = await runEvalArtifact({
        artifactPath: path,
        workspace: root,
        now: () => PINNED,
      });
      expect(result.scenarios[0]?.timed_out).toBe(true);
      expect(result.scenarios[0]?.exit_code).toBeNull();
    } finally {
      await remove();
    }
  });
});

describe('the baseline in a temporary worktree', () => {
  it('fails on the current owner and passes with the change', async () => {
    const { root, remove } = await workspace();
    try {
      const { ref } = await throwawayRepo(root);
      const path = await baselineArtifact(root);

      const outcome = await reproduceBaseline({
        artifactPath: path,
        workspace: root,
        repo: root,
        changeRef: ref,
        now: () => PINNED,
      });

      expect(outcome.baseline_failed).toBe(true);
      expect(outcome.with_change_passed).toBe(true);
      expect(outcome.passed).toBe(true);

      const before = outcome.before?.scenarios.find((scenario) => scenario.phase === 'baseline');
      expect(before?.passed).toBe(false);
      const after = outcome.after?.scenarios.find((scenario) => scenario.phase === 'candidate');
      expect(after?.passed).toBe(true);
    } finally {
      await remove();
    }
  });
});

describe('the signing of a throwaway commit', () => {
  it('turns the signing off on the git commands it spawns', () => {
    expect(gitCommand(['worktree', 'add', '--detach', 'worktree', 'HEAD'])).toEqual([
      'git',
      '-c',
      'commit.gpgsign=false',
      'worktree',
      'add',
      '--detach',
      'worktree',
      'HEAD',
    ]);
  });

  it('completes the run on a machine whose signing agent is locked', async () => {
    const { root, remove } = await workspace();
    const signing = await signingHome();
    const before = process.env.HOME;
    process.env.HOME = signing.home;
    try {
      const { ref } = await throwawayRepo(root);
      const path = await baselineArtifact(root);

      const outcome = await reproduceBaseline({
        artifactPath: path,
        workspace: root,
        repo: root,
        changeRef: ref,
        now: () => PINNED,
      });

      expect(outcome.passed).toBe(true);
      // The signer was never reached: a throwaway commit is not signed.
      expect(await exists(signing.marker)).toBe(false);
    } finally {
      if (before === undefined) delete process.env.HOME;
      else process.env.HOME = before;
      await signing.remove();
      await remove();
    }
  });
});

describe('the boundaries of a run', () => {
  it('refuses a lesson id that is really a path', async () => {
    const { root, remove } = await workspace();
    try {
      const path = await artifactFile(root, [
        { id: 's', phase: 'candidate', cwd: '.', command: ['cat', 'x'], expect: {} },
      ]);
      const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      raw.lesson_id = '../../../../../../../../tmp/oa-escaped-result';
      await writeFile(path, JSON.stringify(raw), 'utf8');
      await expect(
        runEvalArtifact({ artifactPath: path, workspace: root, now: () => PINNED }),
      ).rejects.toThrow(/is not a lesson id/);
    } finally {
      await remove();
    }
  });

  it('refuses a working directory that leaves the workspace through a symlink', async () => {
    const { root, remove } = await workspace();
    const outside = await mkdtemp(join(tmpdir(), 'openagentsy-outside-'));
    try {
      await symlink(outside, join(root, 'link'));
      const path = await artifactFile(root, [
        {
          id: 's',
          phase: 'candidate',
          cwd: 'link',
          command: ['pwd'],
          expect: { stdout_includes: [outside] },
        },
      ]);
      await expect(
        runEvalArtifact({ artifactPath: path, workspace: root, now: () => PINNED }),
      ).rejects.toThrow(/leaves the workspace through a symlink/);
    } finally {
      await rm(outside, { recursive: true, force: true });
      await remove();
    }
  });

  it('refuses to write a result through a symlinked state directory', async () => {
    const { root, remove } = await workspace();
    const outside = await mkdtemp(join(tmpdir(), 'openagentsy-state-'));
    try {
      await symlink(outside, join(root, '.openagentsy'));
      const path = await artifactFile(root, [
        { id: 's', phase: 'candidate', cwd: '.', command: ['cat', 'x'], expect: {} },
      ]);
      await expect(
        runEvalArtifact({ artifactPath: path, workspace: root, now: () => PINNED }),
      ).rejects.toThrow(/symlink/);
      expect(await readdir(outside)).toHaveLength(0);
    } finally {
      await rm(outside, { recursive: true, force: true });
      await remove();
    }
  });

  it('leaves no worktree behind when the add fails', async () => {
    const { root, remove } = await workspace();
    try {
      await runCommand(gitCommand(['init', '-q']), root, 30_000);
      await expect(
        withTemporaryWorktree({
          repo: root,
          ref: 'nosuchref',
          run: async () => 'never',
        }),
      ).rejects.toThrow(/failed/);
      const list = await runCommand(gitCommand(['worktree', 'list']), root, 30_000);
      expect(list.stdout.trim().split('\n')).toHaveLength(1);
    } finally {
      await remove();
    }
  });
});
