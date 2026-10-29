import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PolicyFiring, PolicyFiringSink } from '@openagentsy/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { workspaceWritesOnly } from './policies/workspace-writes-only.js';
import { policyRule } from './policy-rule.js';
import type { HandlerResult, Rule } from './registry.js';
import { defaultRules } from './rules.js';

/**
 * The shell writes the workspace rule has to see.
 *
 * The file tool's paths do not name the files a command writes, so a
 * command that wrote outside the workspace was not seen by the rule that
 * limits the writes to the workspace and the OpenAgentsy worktrees. The
 * matcher reads the command, and the rule acts on what the matcher finds.
 */

/** The name of the workspace fixture, so the worktree path can be pinned. */
const WORKSPACE_NAME = 'oa-workspace-fixture';

/** The home the worktrees of the fixture live under. */
const HOME = '/home/dev';

/**
 * The commands an agent runs all day.
 *
 * The rule must not refuse them: a guard that refuses `git status` is a
 * guard that gets turned off.
 */
const ORDINARY_COMMANDS = [
  'git status',
  'git diff',
  'cat file',
  'ls',
  'grep pattern file',
  'bun test',
  'bun run build',
  'mkdir -p dist',
  'touch dist/x',
  'echo x > dist/y',
  'mktemp',
  'npm install left-pad',
  'pip install left-pad',
  'git commit -m "wip"',
];

/** The reason a result carries, when it stops the call. */
function reasonOf(result: HandlerResult): string | undefined {
  return 'reason' in result ? result.reason : undefined;
}

/** Whether a result lets the call through. */
function continues(result: HandlerResult): boolean {
  return 'continue' in result ? result.continue : true;
}

/** A sink that keeps the firings in memory. */
class Sink implements PolicyFiringSink {
  /** The rows the sink was given. */
  readonly firings: PolicyFiring[] = [];

  record(firing: PolicyFiring): void {
    this.firings.push(firing);
  }
}

let workspace: string;
let stateRoot: string;
let rules: Rule[];

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'oa-workspace-shell-'));
  workspace = join(base, WORKSPACE_NAME);
  await mkdir(workspace, { recursive: true });
  stateRoot = await mkdtemp(join(tmpdir(), 'oa-workspace-state-'));
  rules = defaultRules({ workspace, stateRoot, home: HOME });
});

/** The event a shell call arrives as. */
function shell(command: string): unknown {
  return { toolName: 'bash', args: { command }, files: [] };
}

/** The event a file write arrives as. */
function write(path: string): unknown {
  return { toolName: 'write', args: { filePath: path, content: '' }, files: [{ path }] };
}

/** The decision of the workspace rule on one event. */
async function decide(event: unknown): Promise<HandlerResult> {
  const rule = rules.find((entry) => entry.id === 'workspace-writes-only');
  if (rule === undefined) throw new Error('no rule called workspace-writes-only');
  return rule.handler(event);
}

describe('the workspace rule and a shell write', () => {
  it('blocks a write outside the workspace and names the path', async () => {
    const result = await decide(shell('cp source /tmp/victim.txt'));

    expect(continues(result)).toBe(false);
    expect(reasonOf(result)).toContain('/tmp/victim.txt');
  });

  it('blocks a redirect outside the workspace and names the path', async () => {
    const result = await decide(shell('echo written > /tmp/log'));

    expect(continues(result)).toBe(false);
    expect(reasonOf(result)).toContain('/tmp/log');
  });

  it('blocks a write outside the workspace behind a quoted command', async () => {
    const result = await decide(shell('bash -c "cp source /tmp/victim.txt"'));

    expect(continues(result)).toBe(false);
    expect(reasonOf(result)).toContain('/tmp/victim.txt');
  });

  it('lets a write inside the workspace through', async () => {
    const result = await decide(shell('echo x > dist/y'));

    expect(continues(result)).toBe(true);
  });

  it('lets a write inside a worktree of the project through', async () => {
    const result = await decide(
      shell(`cp source ${HOME}/.openagentsy/worktrees/${WORKSPACE_NAME}/src/a.ts`),
    );

    expect(continues(result)).toBe(true);
  });

  it('blocks a write the matcher cannot place', async () => {
    // The command names no path, so the guard cannot show that the write
    // lands inside the workspace. The stance is fail-closed.
    const result = await decide(shell('git stash'));

    expect(continues(result)).toBe(false);
  });

  it('still blocks a write of the file tool outside the workspace', async () => {
    const result = await decide(write('/elsewhere/file.ts'));

    expect(continues(result)).toBe(false);
  });

  it('lets the ordinary commands through', async () => {
    for (const command of ORDINARY_COMMANDS) {
      const result = await decide(shell(command));
      expect(continues(result), command).toBe(true);
    }
  });

  it('keeps the reason of a refusal in the shape the rule always had', async () => {
    const result = await decide(shell('cp source /tmp/victim.txt'));

    expect(reasonOf(result)).toContain(
      'Writes are limited to the workspace and OpenAgentsy worktrees.',
    );
  });
});

describe('the firing of the workspace rule', () => {
  it('writes one row for one evaluation', async () => {
    const sink = new Sink();
    const rule = policyRule(workspaceWritesOnly({ workspace, home: HOME }), {
      id: 'workspace-writes-only',
      firings: sink,
    });

    // The call carries a command and a file, and both branches of the rule
    // would refuse it. One evaluation is one row.
    const result = await rule.handler({
      toolName: 'bash',
      args: { command: 'cp source /tmp/victim.txt' },
      files: [{ path: '/elsewhere/file.ts' }],
    });

    expect(continues(result)).toBe(false);
    expect(sink.firings).toHaveLength(1);
    expect(sink.firings[0]).toMatchObject({
      policyId: 'oa.workspace-writes-only',
      action: 'block',
    });
  });
});
