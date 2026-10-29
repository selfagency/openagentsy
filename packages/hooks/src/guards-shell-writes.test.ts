import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type ShellViolation, shellViolation, shellWriteTargets } from './guards.js';
import { protectPolicy } from './policies/protect-policy.js';
import type { PolicyContext } from './policy.js';
import type { HandlerResult, Rule } from './registry.js';
import { defaultRules } from './rules.js';

/**
 * The shell writes the protect policy has to see.
 *
 * The file tool is refused a write to a file a person changes, and a plain
 * `cp` of the same file was not: the policy read the file tool's paths and
 * nothing else. So the matcher here reads the shell, and the policy and the
 * legacy rule both act on what it finds.
 */

/** The paths a command would write. */
function targetsOf(command: string): (string | undefined)[] {
  return shellWriteTargets(command).map((write) => write.path);
}

/** What a command earns from the guard. */
function violationOf(command: string, root?: string): ShellViolation | undefined {
  return shellViolation(command, root);
}

/** The context of a shell call, as the policy is asked about it. */
function ctx(command: string): PolicyContext {
  return {
    toolCall: { name: 'bash', args: { command } },
    files: [],
    session: { id: 'session-1', roleId: 'oa-builder' },
  };
}

/** The event a shell call arrives as. */
function shell(command: string): unknown {
  return { toolName: 'bash', args: { command }, files: [] };
}

/** The rules of a workspace. */
async function rulesOf(): Promise<Rule[]> {
  const base = await mkdtemp(join(tmpdir(), 'oa-shell-writes-'));
  const workspace = join(base, 'oa-workspace-fixture');
  await mkdir(workspace, { recursive: true });
  const stateRoot = await mkdtemp(join(tmpdir(), 'oa-shell-state-'));
  return defaultRules({ workspace, stateRoot, home: '/home/dev' });
}

/** The result of the protect rule. */
async function decide(rules: readonly Rule[], command: string): Promise<HandlerResult> {
  const rule = rules.find((entry) => entry.id === 'protect-policy');
  if (rule === undefined) throw new Error('no rule called protect-policy');
  return rule.handler(shell(command));
}

/** Whether a result lets the call through. */
function continues(result: HandlerResult): boolean {
  return 'continue' in result ? result.continue : true;
}

/** The reason a result carries, when it stops the call. */
function reasonOf(result: HandlerResult): string | undefined {
  return 'reason' in result ? result.reason : undefined;
}

/** A patch that writes one file. */
function patchFor(path: string): string {
  return `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;
}

describe('the write targets of a shell command', () => {
  it('reads the file every writer form writes', () => {
    const forms: [string, string][] = [
      ['cp source roles.yaml', 'roles.yaml'],
      ['mv roles.yaml /tmp/roles.yaml', 'roles.yaml'],
      ['ln -s source roles.yaml', 'roles.yaml'],
      ['tee roles.yaml', 'roles.yaml'],
      ["sed -i 's/a/b/' roles.yaml", 'roles.yaml'],
      ['truncate -s 0 roles.yaml', 'roles.yaml'],
      ['install -m 644 source roles.yaml', 'roles.yaml'],
      ['dd if=/dev/zero of=roles.yaml', 'roles.yaml'],
      ['echo written > roles.yaml', 'roles.yaml'],
      ['echo written >> roles.yaml', 'roles.yaml'],
      ['rm roles.yaml', 'roles.yaml'],
      ['git checkout -- roles.yaml', 'roles.yaml'],
      ['git restore roles.yaml', 'roles.yaml'],
      ['touch roles.yaml', 'roles.yaml'],
      ['mkdir .opencode/agents', '.opencode/agents'],
      ['chmod 644 roles.yaml', 'roles.yaml'],
      ['chown dev roles.yaml', 'roles.yaml'],
      ['rsync -a src/ roles.yaml', 'roles.yaml'],
    ];
    for (const [command, expected] of forms) {
      expect(targetsOf(command), command).toContain(expected);
    }
  });

  it('writes the destination of a copy and the source of a move', () => {
    expect(targetsOf('cp source dest.yaml')).toEqual(['dest.yaml']);
    expect(targetsOf('mv source dest.yaml')).toEqual(['source', 'dest.yaml']);
  });

  it('writes the last operand of an install and every operand of a removal', () => {
    expect(targetsOf('install -m 644 source dest.yaml')).toEqual(['dest.yaml']);
    expect(targetsOf('rm one.yaml two.yaml')).toEqual(['one.yaml', 'two.yaml']);
  });

  it('does not mistake a flag value for a path', () => {
    expect(targetsOf('install -m 644 source dest.yaml')).not.toContain('644');
    expect(targetsOf('truncate -s 0 roles.yaml')).not.toContain('0');
    expect(targetsOf('sed -i -e s/a/b/ roles.yaml')).toEqual(['roles.yaml']);
    expect(targetsOf('chmod 644 roles.yaml')).toEqual(['roles.yaml']);
    expect(targetsOf('chown dev roles.yaml')).toEqual(['roles.yaml']);
    expect(targetsOf('mkdir -m 755 .opencode/agents')).toEqual(['.opencode/agents']);
  });

  it('names no path for a git command that writes files it names no path for', () => {
    expect(targetsOf('git apply fix.patch')).toEqual([undefined]);
    expect(targetsOf('git stash')).toEqual([undefined]);
    expect(targetsOf('git checkout -- .')).toEqual([undefined]);
  });

  it('reads a command that is passed as a quoted argument', () => {
    expect(targetsOf('bash -c "cp source roles.yaml"')).toContain('roles.yaml');
  });

  it('reads a command that is behind a substitution', () => {
    expect(targetsOf('echo $(cp source roles.yaml)')).toContain('roles.yaml');
  });

  it('reads the target of a redirect', () => {
    expect(targetsOf('echo written > roles.yaml')).toContain('roles.yaml');
    expect(targetsOf('echo written >> roles.yaml')).toContain('roles.yaml');
  });

  it('names no write for a command that only reads', () => {
    const readers = [
      'cat roles.yaml',
      'grep pattern roles.yaml',
      'git diff roles.yaml',
      'git status',
      'ls .github/workflows',
    ];
    for (const command of readers) {
      expect(targetsOf(command), command).toEqual([]);
    }
  });

  it('names no write for a command it does not know', () => {
    expect(targetsOf('some-tool --flag roles.yaml')).toEqual([]);
  });
});

describe('the protected path a shell command writes', () => {
  it('names the protected file a command writes', () => {
    const forms = [
      'cp source roles.yaml',
      'mv roles.yaml /tmp/roles.yaml',
      "sed -i 's/a/b/' roles.yaml",
      'echo written > roles.yaml',
      'rm roles.yaml',
      'git checkout -- roles.yaml',
      'git restore roles.yaml',
      'bash -c "cp source roles.yaml"',
    ];
    for (const command of forms) {
      expect(violationOf(command)?.kind, command).toBe('protected');
    }
  });

  it('names the protected file in a nested directory', () => {
    expect(violationOf('cp source .github/workflows/publish.yml')).toEqual({
      kind: 'protected',
      path: '.github/workflows/publish.yml',
    });
    expect(violationOf('cp source .opencode/agents/lead.md')).toEqual({
      kind: 'protected',
      path: '.opencode/agents/lead.md',
    });
  });

  it('names nothing when the command writes an ordinary file', () => {
    expect(violationOf('cp source src/a.ts')).toBeUndefined();
    expect(violationOf('echo written > src/a.ts')).toBeUndefined();
  });

  it('names nothing when the command only reads', () => {
    for (const command of ['cat roles.yaml', 'git diff roles.yaml', 'git status']) {
      expect(violationOf(command), command).toBeUndefined();
    }
  });

  it('lets bun write the lockfile', () => {
    expect(violationOf('bun install')).toBeUndefined();
    expect(violationOf('bun add left-pad')).toBeUndefined();
    expect(violationOf('bun remove left-pad')).toBeUndefined();
  });

  it('lets the generator write the agent files', () => {
    expect(violationOf('openagentsy build')).toBeUndefined();
    expect(violationOf('bun run openagentsy build')).toBeUndefined();
    expect(violationOf('bun packages/cli/dist/index.js build')).toBeUndefined();
  });

  it('does not let a copy write the lockfile', () => {
    expect(violationOf('cp source bun.lock')).toEqual({ kind: 'protected', path: 'bun.lock' });
  });

  it('does not let the generator write the roles file', () => {
    expect(violationOf('cp source roles.yaml')).toEqual({ kind: 'protected', path: 'roles.yaml' });
  });
});

describe('the blind writers', () => {
  it('refuses a git apply that names no patch', () => {
    expect(violationOf('git apply')).toEqual({ kind: 'blind', command: 'git apply' });
  });

  it('refuses a git apply whose patch cannot be read', () => {
    expect(violationOf('git apply missing.patch')).toEqual({
      kind: 'blind',
      command: 'git apply',
    });
  });

  it('refuses a git stash with no pathspec', () => {
    expect(violationOf('git stash')).toEqual({ kind: 'blind', command: 'git stash' });
  });

  it('refuses a checkout of the whole tree', () => {
    expect(violationOf('git checkout -- .')).toEqual({ kind: 'blind', command: 'git checkout' });
    expect(violationOf('git checkout .')).toEqual({ kind: 'blind', command: 'git checkout' });
  });

  it('refuses a restore of the whole tree', () => {
    expect(violationOf('git restore')).toEqual({ kind: 'blind', command: 'git restore' });
    expect(violationOf('git restore .')).toEqual({ kind: 'blind', command: 'git restore' });
  });

  it('checks a checkout that names a path', () => {
    expect(violationOf('git checkout -- roles.yaml')).toEqual({
      kind: 'protected',
      path: 'roles.yaml',
    });
    expect(violationOf('git checkout -- src/index.ts')).toBeUndefined();
  });

  it('checks a stash that names a path', () => {
    expect(violationOf('git stash push -- roles.yaml')).toEqual({
      kind: 'protected',
      path: 'roles.yaml',
    });
    expect(violationOf('git stash push -- src/index.ts')).toBeUndefined();
  });

  it('lets a checkout of a branch through', () => {
    expect(violationOf('git checkout -b feature')).toBeUndefined();
  });

  it('reads the targets of a patch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oa-patch-'));
    const patch = join(dir, 'fix.patch');
    await writeFile(patch, patchFor('roles.yaml'), 'utf8');
    expect(violationOf(`git apply ${patch}`)).toEqual({ kind: 'protected', path: 'roles.yaml' });
  });

  it('lets a patch of an ordinary file through', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oa-patch-'));
    const patch = join(dir, 'fix.patch');
    await writeFile(patch, patchFor('src/index.ts'), 'utf8');
    expect(violationOf(`git apply ${patch}`)).toBeUndefined();
  });
});

describe('the other writers', () => {
  it('refuses a mkdir inside a protected directory', () => {
    expect(violationOf('mkdir -p .opencode/agents')).toEqual({
      kind: 'protected',
      path: '.opencode/agents',
    });
    expect(violationOf('mkdir .github/workflows')).toEqual({
      kind: 'protected',
      path: '.github/workflows',
    });
  });

  it('lets a mkdir of an ordinary directory through', () => {
    expect(violationOf('mkdir -p build/x')).toBeUndefined();
  });

  it('refuses a chmod of a protected file', () => {
    expect(violationOf('chmod 644 roles.yaml')).toEqual({
      kind: 'protected',
      path: 'roles.yaml',
    });
    expect(violationOf('chmod 644 src/a.ts')).toBeUndefined();
  });

  it('refuses a chown of a protected file', () => {
    expect(violationOf('chown dev roles.yaml')).toEqual({
      kind: 'protected',
      path: 'roles.yaml',
    });
    expect(violationOf('chown dev src/a.ts')).toBeUndefined();
  });

  it('refuses an rsync into a protected path', () => {
    expect(violationOf('rsync -a src/ .github/workflows/')).toEqual({
      kind: 'protected',
      path: '.github/workflows/',
    });
    expect(violationOf('rsync -a roles.yaml /tmp/')).toEqual({
      kind: 'protected',
      path: 'roles.yaml',
    });
  });

  it('lets an rsync into an ordinary path through', () => {
    expect(violationOf('rsync -a src/ build/')).toBeUndefined();
  });
});

describe('the protect policy', () => {
  it('refuses a shell write to a file a person changes', () => {
    const result = protectPolicy.evaluate(ctx('cp source roles.yaml'));
    expect(result.action).toBe('block');
  });

  it('refuses a shell write to a workflow', () => {
    const result = protectPolicy.evaluate(ctx('cp source .github/workflows/publish.yml'));
    expect(result.action).toBe('block');
  });

  it('refuses a blind write and says to name the paths', () => {
    const result = protectPolicy.evaluate(ctx('git stash'));
    expect(result.action).toBe('block');
    if (result.action === 'block') {
      expect(result.reason).toContain('git stash');
      expect(result.reason).toContain('Name the paths it writes');
    }
  });

  it('lets a shell write to an ordinary file through', () => {
    const result = protectPolicy.evaluate(ctx('cp source src/a.ts'));
    expect(result.action).toBe('allow');
  });

  it('lets a shell read through', () => {
    const result = protectPolicy.evaluate(ctx('cat roles.yaml'));
    expect(result.action).toBe('allow');
  });

  it('says the same thing as the file tool refusal', () => {
    const shellResult = protectPolicy.evaluate(ctx('cp source roles.yaml'));
    const fileResult = protectPolicy.evaluate({
      toolCall: { name: 'write', args: { filePath: 'roles.yaml', content: '' } },
      files: [{ path: 'roles.yaml' }],
      session: { id: 'session-1', roleId: 'oa-builder' },
    });
    expect(shellResult.action).toBe('block');
    expect(fileResult.action).toBe('block');
    if (shellResult.action === 'block' && fileResult.action === 'block') {
      expect(shellResult.reason).toBe(fileResult.reason);
    }
  });
});

describe('the protect rule', () => {
  it('refuses a shell write to a file a person changes', async () => {
    const rules = await rulesOf();
    const result = await decide(rules, 'cp source roles.yaml');
    expect(continues(result)).toBe(false);
  });

  it('refuses a shell write to a workflow', async () => {
    const rules = await rulesOf();
    const result = await decide(rules, 'echo written > .github/workflows/publish.yml');
    expect(continues(result)).toBe(false);
  });

  it('refuses a blind write and says to name the paths', async () => {
    const rules = await rulesOf();
    const result = await decide(rules, 'git apply');
    expect(continues(result)).toBe(false);
    expect(reasonOf(result)).toContain('git apply');
  });

  it('lets a shell write to an ordinary file through', async () => {
    const rules = await rulesOf();
    const result = await decide(rules, 'cp source src/a.ts');
    expect(continues(result)).toBe(true);
  });

  it('lets a shell read through', async () => {
    const rules = await rulesOf();
    const result = await decide(rules, 'cat roles.yaml');
    expect(continues(result)).toBe(true);
  });

  it('lets bun write the lockfile', async () => {
    const rules = await rulesOf();
    const result = await decide(rules, 'bun install');
    expect(continues(result)).toBe(true);
  });
});
