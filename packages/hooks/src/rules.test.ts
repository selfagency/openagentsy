import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApprovalStore } from './approvals.js';
import type { HandlerResult, Rule } from './registry.js';
import { defaultRules, isProtected } from './rules.js';

// The fixture is assembled from segments on purpose: the value is the real
// shape the rule pins, and the source carries no contiguous secret for a
// scanner to flag. It is not a credential.
const SECRET_VALUE = ['aB3dF6hJ', '9kM2nP5rT', '8vW1xZ4cE', '7gH0'].join('');
const SECRET_CONTENT = `api_key = ${SECRET_VALUE}`;

/** The name of the workspace fixture, so the worktree path can be pinned. */
const WORKSPACE_NAME = 'oa-workspace-fixture';

/** The reason a result carries, when it stops the call. */
function reasonOf(result: HandlerResult): string | undefined {
  return 'reason' in result ? result.reason : undefined;
}

/** Whether a result lets the call through. */
function continues(result: HandlerResult): boolean {
  return 'continue' in result ? result.continue : true;
}

let workspace: string;
let stateRoot: string;
let rules: Rule[];

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'oa-wt-'));
  workspace = join(base, WORKSPACE_NAME);
  await mkdir(workspace, { recursive: true });
  stateRoot = await mkdtemp(join(tmpdir(), 'oa-state-'));
  rules = defaultRules({ workspace, stateRoot, home: '/home/dev' });
});

function ruleOf(id: string): Rule {
  const found = rules.find((rule) => rule.id === id);
  if (found === undefined) throw new Error(`no rule called ${id}`);
  return found;
}

async function decide(id: string, event: unknown): Promise<HandlerResult> {
  return ruleOf(id).handler(event);
}

/** The event a shell call arrives as. */
function shell(command: string, extra: Record<string, unknown> = {}): unknown {
  return { toolName: 'bash', args: {}, files: [], command, ...extra };
}

/** The event a file write arrives as. */
function write(path: string, content = ''): unknown {
  return { toolName: 'write', args: { filePath: path, content }, files: [{ path }] };
}

describe('the default rules', () => {
  it('is the seven rules of the plan, in the plan order', () => {
    expect(rules.map((rule) => rule.id)).toEqual([
      'no-skip-git-hooks',
      'package-manager',
      'workspace-writes-only',
      'protect-policy',
      'human-only-decisions',
      'secret-scan-writes',
      'destructive-needs-approval',
    ]);
  });

  it('blocks every one of them', () => {
    for (const rule of rules) expect(rule.block).toBe(true);
  });

  it('is checked before a tool call', () => {
    for (const rule of rules) expect(rule.event).toBe('PreToolCall');
  });
});

describe('no-skip-git-hooks', () => {
  it('blocks a commit that skips the hooks', async () => {
    const result = await decide('no-skip-git-hooks', shell('git commit --no-verify -m "wip"'));
    expect(continues(result)).toBe(false);
  });

  it('blocks a bare -n right after git commit', async () => {
    expect(continues(await decide('no-skip-git-hooks', shell('git commit -n')))).toBe(false);
  });

  it('blocks the -n behind the message', async () => {
    expect(continues(await decide('no-skip-git-hooks', shell('git commit -m "wip" -n')))).toBe(
      false,
    );
  });

  it('blocks the -n behind another flag', async () => {
    expect(continues(await decide('no-skip-git-hooks', shell('git commit -a -n')))).toBe(false);
  });

  it('blocks the -n behind an amend', async () => {
    expect(continues(await decide('no-skip-git-hooks', shell('git commit --amend -n')))).toBe(
      false,
    );
  });

  it('blocks the -n in a flag cluster', async () => {
    expect(continues(await decide('no-skip-git-hooks', shell('git commit -nm "wip"')))).toBe(false);
  });

  it('blocks the husky switch', async () => {
    expect(continues(await decide('no-skip-git-hooks', shell('HUSKY=0 git commit -m "wip"')))).toBe(
      false,
    );
  });

  it('lets a commit that only talks about -n through', async () => {
    const result = await decide('no-skip-git-hooks', shell('git commit -m "fix -n handling"'));
    expect(continues(result)).toBe(true);
  });

  it('lets a commit whose message names the long flag through', async () => {
    const result = await decide(
      'no-skip-git-hooks',
      shell('git commit -m "docs: note --no-verify"'),
    );
    expect(continues(result)).toBe(true);
  });

  it('blocks a commit that is passed as a quoted argument', async () => {
    expect(continues(await decide('no-skip-git-hooks', shell('bash -c "git commit -n"')))).toBe(
      false,
    );
    expect(
      continues(await decide('no-skip-git-hooks', shell('bash -c "git commit --no-verify"'))),
    ).toBe(false);
    expect(
      continues(await decide('no-skip-git-hooks', shell('bash -c "HUSKY=0 git commit -m x"'))),
    ).toBe(false);
  });

  it('blocks the abbreviations of the long flag', async () => {
    expect(continues(await decide('no-skip-git-hooks', shell('git commit --no-verif -m x')))).toBe(
      false,
    );
    expect(continues(await decide('no-skip-git-hooks', shell('git commit --no-veri -m x')))).toBe(
      false,
    );
  });

  it('lets the options that only look like the flag through', async () => {
    expect(
      continues(await decide('no-skip-git-hooks', shell('git commit --no-verbose -m x'))),
    ).toBe(true);
    expect(
      continues(await decide('no-skip-git-hooks', shell('git merge --no-verify-signatures'))),
    ).toBe(true);
    expect(continues(await decide('no-skip-git-hooks', shell('git commit --no-ver -m x')))).toBe(
      true,
    );
  });

  it('lets a -n that belongs to another command through', async () => {
    expect(continues(await decide('no-skip-git-hooks', shell('git merge -n')))).toBe(true);
    expect(continues(await decide('no-skip-git-hooks', shell('git rebase -n')))).toBe(true);
    expect(continues(await decide('no-skip-git-hooks', shell('sudo -n git commit -m x')))).toBe(
      true,
    );
    expect(continues(await decide('no-skip-git-hooks', shell('git commit -m add -- -n')))).toBe(
      true,
    );
  });

  it('lets an ordinary commit through', async () => {
    expect(continues(await decide('no-skip-git-hooks', shell('git commit -m "wip"')))).toBe(true);
  });
});

describe('package-manager', () => {
  it('blocks another package manager', async () => {
    expect(continues(await decide('package-manager', shell('pnpm add x')))).toBe(false);
    expect(continues(await decide('package-manager', shell('npm install')))).toBe(false);
    expect(continues(await decide('package-manager', shell('yarn add x')))).toBe(false);
  });

  it('blocks another package manager behind a path', async () => {
    expect(continues(await decide('package-manager', shell('/usr/local/bin/pnpm add x')))).toBe(
      false,
    );
    expect(
      continues(await decide('package-manager', shell('./node_modules/.bin/pnpm add x'))),
    ).toBe(false);
  });

  it('blocks another package manager in another case', async () => {
    expect(continues(await decide('package-manager', shell('PNPM add x')))).toBe(false);
  });

  it('lets bun through', async () => {
    expect(continues(await decide('package-manager', shell('bun add x')))).toBe(true);
  });
});

describe('workspace-writes-only', () => {
  it('blocks a write outside the workspace', async () => {
    const result = await decide('workspace-writes-only', write('/elsewhere/file.ts'));
    expect(continues(result)).toBe(false);
  });

  it('lets a write inside the workspace through', async () => {
    const result = await decide('workspace-writes-only', write(join(workspace, 'src/a.ts')));
    expect(continues(result)).toBe(true);
  });

  it('lets a write inside a worktree of the project through', async () => {
    // The path is pinned, so the test fails when the rule looks in the
    // wrong place.
    const result = await decide('workspace-writes-only', {
      toolName: 'write',
      args: { filePath: '/home/dev/.openagentsy/worktrees/oa-workspace-fixture/src/a.ts' },
      files: [],
    });
    expect(continues(result)).toBe(true);
  });

  it('lets a read of a file through', async () => {
    const result = await decide('workspace-writes-only', {
      toolName: 'read',
      args: { filePath: '/etc/passwd' },
      files: [],
    });
    expect(continues(result)).toBe(true);
  });

  it('lets a search through', async () => {
    const result = await decide('workspace-writes-only', {
      toolName: 'grep',
      args: { path: '/tmp' },
      files: [],
    });
    expect(continues(result)).toBe(true);
  });

  it('lets a read of a file through, even when the host says which file it read', async () => {
    const path = '.opencode/skills/openagentsy-review/SKILL.md';
    const result = await decide('workspace-writes-only', {
      toolName: 'read',
      args: { filePath: path },
      files: [{ path }],
    });
    expect(continues(result)).toBe(true);
    const protectedResult = await decide('protect-policy', {
      toolName: 'read',
      args: { filePath: path },
      files: [{ path }],
    });
    expect(continues(protectedResult)).toBe(true);
  });

  it('knows the tools a host composes', async () => {
    for (const tool of ['write_file', 'create_file']) {
      const result = await decide('workspace-writes-only', {
        toolName: tool,
        args: { filePath: '/elsewhere/file.ts' },
        files: [],
      });
      expect(continues(result), tool).toBe(false);
    }
  });

  it('lets a call that touches no file through', async () => {
    expect(continues(await decide('workspace-writes-only', shell('ls -la')))).toBe(true);
  });
});

describe('protect-policy', () => {
  it('blocks the files a person changes', async () => {
    const protectedPaths = [
      'roles.yaml',
      'openagentsy.models.lock.json',
      'opencode.jsonc',
      'biome.jsonc',
      'turbo.json',
      'bun.lock',
      '.opencode/agents/lead.md',
      '.husky/pre-commit',
      '.github/workflows/check.yml',
      'templates/.opencode/skills/x/SKILL.md',
      '.openagentsy/lessons/one.json',
      '.openagentsy/quality/waivers.json',
      '.openagentsy/approvals.json',
    ];
    for (const path of protectedPaths) {
      const result = await decide('protect-policy', write(join(workspace, path)));
      expect(continues(result), path).toBe(false);
    }
  });

  it('blocks a directory that is named without its slash', async () => {
    for (const path of ['.opencode', 'templates', 'roles.yaml/']) {
      expect(isProtected(path), path).toBe(true);
      const result = await decide('protect-policy', write(path));
      expect(continues(result), path).toBe(false);
    }
  });

  it('blocks the lock of the approval store', async () => {
    expect(isProtected('.openagentsy/approvals.json.lock')).toBe(true);
    const result = await decide('protect-policy', write('.openagentsy/approvals.json.lock'));
    expect(continues(result)).toBe(false);
  });

  it('lets a read of a policy file through', async () => {
    const result = await decide('protect-policy', {
      toolName: 'read',
      args: { filePath: '.opencode/skills/openagentsy-review/SKILL.md' },
      files: [],
    });
    expect(continues(result)).toBe(true);
  });

  it('lets an ordinary file through', async () => {
    const result = await decide('protect-policy', write(join(workspace, 'src/a.ts')));
    expect(continues(result)).toBe(true);
  });
});

describe('human-only-decisions', () => {
  it('blocks the three decision tools', async () => {
    for (const tool of [
      'oa_lesson_decide',
      'oa_quality_waive',
      'openagentsy_oa_quality_waive',
      'oa_memory_decide',
    ]) {
      const result = await decide('human-only-decisions', { toolName: tool, args: {}, files: [] });
      expect(continues(result), tool).toBe(false);
    }
  });

  it('blocks a decision tool behind a server prefix', async () => {
    const result = await decide('human-only-decisions', {
      toolName: 'openagentsy-lessons_oa_lesson_decide',
      args: {},
      files: [],
    });
    expect(continues(result)).toBe(false);
  });

  it('lets an ordinary tool through', async () => {
    const result = await decide('human-only-decisions', {
      toolName: 'oa_task_list',
      args: {},
      files: [],
    });
    expect(continues(result)).toBe(true);
  });
});

describe('secret-scan-writes', () => {
  it('blocks content that carries a secret', async () => {
    const result = await decide(
      'secret-scan-writes',
      write(join(workspace, 'src/a.ts'), SECRET_CONTENT),
    );
    expect(continues(result)).toBe(false);
    expect(reasonOf(result)).toContain('credential');
  });

  it('lets clean content through', async () => {
    const result = await decide(
      'secret-scan-writes',
      write(join(workspace, 'src/a.ts'), 'export const answer = 42;'),
    );
    expect(continues(result)).toBe(true);
  });

  it('scans the content of the tools a host composes', async () => {
    for (const tool of ['write_file', 'create_file']) {
      const result = await decide('secret-scan-writes', {
        toolName: tool,
        args: { content: SECRET_CONTENT },
        files: [],
      });
      expect(continues(result), tool).toBe(false);
    }
  });

  it('finds a secret in the lines a patch adds', async () => {
    const patch = ['*** Update File: src/a.ts', '@@', `+const api_key = '${SECRET_VALUE}';`].join(
      '\n',
    );
    const result = await decide('secret-scan-writes', {
      toolName: 'apply_patch',
      args: { patchText: patch },
      files: [{ path: 'src/a.ts' }],
    });
    expect(continues(result)).toBe(false);
  });
});

describe('destructive-needs-approval', () => {
  it('blocks a destructive command and names the escape hatch', async () => {
    const result = await decide(
      'destructive-needs-approval',
      shell('rm -rf /', { callID: 'call-9' }),
    );
    expect(continues(result)).toBe(false);
    expect(reasonOf(result)).toContain('/oa approve <callID>');
  });

  it('blocks the destructive flags in any order', async () => {
    expect(continues(await decide('destructive-needs-approval', shell('rm -fr /')))).toBe(false);
    expect(continues(await decide('destructive-needs-approval', shell('rm -r -f /')))).toBe(false);
  });

  it('blocks the destructive flags in their long form', async () => {
    expect(
      continues(await decide('destructive-needs-approval', shell('rm --recursive --force /'))),
    ).toBe(false);
  });

  it('blocks a destructive command behind a separator', async () => {
    expect(continues(await decide('destructive-needs-approval', shell('ls;rm -rf /')))).toBe(false);
    expect(continues(await decide('destructive-needs-approval', shell('ls && rm -rf /')))).toBe(
      false,
    );
  });

  it('blocks a forced push and a hard reset', async () => {
    expect(continues(await decide('destructive-needs-approval', shell('git push --force')))).toBe(
      false,
    );
    expect(
      continues(await decide('destructive-needs-approval', shell('git reset --hard HEAD'))),
    ).toBe(false);
  });

  it('lets an approved call through once', async () => {
    await createApprovalStore(stateRoot).approve('call-9', Date.now(), 60_000);
    const first = await decide(
      'destructive-needs-approval',
      shell('rm -rf /', { callID: 'call-9' }),
    );
    expect(continues(first)).toBe(true);
    const second = await decide(
      'destructive-needs-approval',
      shell('rm -rf /', { callID: 'call-9' }),
    );
    expect(continues(second)).toBe(false);
  });

  it('blocks a removal whose flags come after the operand', async () => {
    expect(continues(await decide('destructive-needs-approval', shell('rm build -rf')))).toBe(
      false,
    );
    expect(continues(await decide('destructive-needs-approval', shell('rm -r build -f')))).toBe(
      false,
    );
    expect(
      continues(await decide('destructive-needs-approval', shell('rm -r build --force'))),
    ).toBe(false);
  });

  it('lets a message that talks about a removal through', async () => {
    expect(
      continues(
        await decide('destructive-needs-approval', shell('git commit -m "docs: explain rm -rf /"')),
      ),
    ).toBe(true);
    expect(
      continues(
        await decide('destructive-needs-approval', shell('git commit -m "never git push --force"')),
      ),
    ).toBe(true);
    expect(
      continues(
        await decide(
          'destructive-needs-approval',
          shell('git commit -m "drop table in a migration"'),
        ),
      ),
    ).toBe(true);
  });

  it('lets a removal that is not both recursive and forced through', async () => {
    expect(continues(await decide('destructive-needs-approval', shell('rm -r build')))).toBe(true);
    expect(continues(await decide('destructive-needs-approval', shell('rm -R build')))).toBe(true);
    expect(continues(await decide('destructive-needs-approval', shell('rm -f /tmp/x')))).toBe(true);
  });

  it('blocks a recursive and forced removal in any spelling', async () => {
    expect(continues(await decide('destructive-needs-approval', shell('rm -Rf /')))).toBe(false);
  });

  it('blocks a destructive command inside a substitution', async () => {
    expect(continues(await decide('destructive-needs-approval', shell('echo $(rm -rf /)')))).toBe(
      false,
    );
  });

  it('blocks a destructive command inside a quoted argument', async () => {
    expect(continues(await decide('destructive-needs-approval', shell('bash -c "rm -rf /"')))).toBe(
      false,
    );
  });

  it('lets an ordinary command through', async () => {
    expect(
      continues(await decide('destructive-needs-approval', shell('rm build/output.txt'))),
    ).toBe(true);
  });
});

describe('the raw host shape', () => {
  it('reads the command out of the arguments', async () => {
    const result = await decide('no-skip-git-hooks', {
      toolName: 'bash',
      args: { command: 'git commit --no-verify' },
      files: [],
    });
    expect(continues(result)).toBe(false);
  });

  it('reads the file out of the arguments', async () => {
    const result = await decide('workspace-writes-only', {
      toolName: 'write',
      args: { filePath: '/etc/passwd' },
      files: [],
    });
    expect(continues(result)).toBe(false);
  });

  it('reads the content out of the arguments', async () => {
    const result = await decide('secret-scan-writes', {
      toolName: 'write',
      args: { content: SECRET_CONTENT },
      files: [],
    });
    expect(continues(result)).toBe(false);
  });
});

describe('the commands that hide their payload', () => {
  it('blocks a removal that hides in a substitution', async () => {
    expect(
      continues(
        await decide('destructive-needs-approval', shell('git commit -m "$(rm -rf /tmp/victim)"')),
      ),
    ).toBe(false);
  });

  it('blocks a hook skip that hides in a substitution', async () => {
    expect(
      continues(await decide('no-skip-git-hooks', shell('git commit -m "$(git commit -n)"'))),
    ).toBe(false);
  });

  it('blocks a removal that hides in a process substitution', async () => {
    expect(
      continues(await decide('destructive-needs-approval', shell('git commit -F <(rm -rf /)'))),
    ).toBe(false);
  });

  it('blocks a removal behind another command', async () => {
    expect(
      continues(await decide('destructive-needs-approval', shell('unshare -m rm -rf /tmp/x'))),
    ).toBe(false);
  });

  it('blocks another package manager that hides in a substitution', async () => {
    expect(continues(await decide('package-manager', shell('echo $(pnpm add x)')))).toBe(false);
  });
});

describe('the removals of two segments', () => {
  it('lets them through when neither is dangerous', async () => {
    expect(
      continues(await decide('destructive-needs-approval', shell('rm -r build; rm -f /tmp/x'))),
    ).toBe(true);
    expect(
      continues(
        await decide('destructive-needs-approval', shell('rm build && tar -rf archive.tar file')),
      ),
    ).toBe(true);
  });
});

describe('the tools a host composes', () => {
  it('treats an unknown name that carries files as a writer', async () => {
    const path = '.opencode/skills/openagentsy-review/SKILL.md';
    const copy = await decide('protect-policy', {
      toolName: 'copy_file',
      args: { filePath: path },
      files: [{ path }],
    });
    expect(continues(copy)).toBe(false);
  });

  it('blocks a write outside the workspace', async () => {
    for (const tool of ['push_files', 'upload_file']) {
      const result = await decide('workspace-writes-only', {
        toolName: tool,
        args: { filePath: '/elsewhere/a.ts' },
        files: [{ path: '/elsewhere/a.ts' }],
      });
      expect(continues(result), tool).toBe(false);
    }
  });

  it('scans the content of a tool it does not know', async () => {
    const result = await decide('secret-scan-writes', {
      toolName: 'save_file',
      args: { content: SECRET_CONTENT, filePath: 'a.ts' },
      files: [{ path: 'a.ts' }],
    });
    expect(continues(result)).toBe(false);
  });

  it('blocks a directory a person changes', async () => {
    const result = await decide('protect-policy', {
      toolName: 'create_directory',
      args: { filePath: '.opencode/skills' },
      files: [{ path: '.opencode/skills' }],
    });
    expect(continues(result)).toBe(false);
  });
});

describe('the removals in a subshell', () => {
  it('blocks a removal behind the punctuation of the shell', async () => {
    const commands = [
      '(rm -rf /tmp/victim)',
      'bash -c "(rm -rf /tmp/victim)"',
      "sh -c '(rm -rf /tmp/victim)'",
      'time (rm -rf /tmp/victim)',
      '\\rm -rf /tmp/victim',
      '( rm -rf /tmp/victim )',
    ];
    for (const command of commands) {
      const result = await decide('destructive-needs-approval', shell(command));
      expect(continues(result), command).toBe(false);
    }
  });
});

describe('a name the matcher does not know', () => {
  it('treats a call that carries files as a writer', async () => {
    const result = await decide('protect-policy', {
      toolName: 'some_new_tool',
      args: { filePath: '.opencode/skills/openagentsy-review/SKILL.md' },
      files: [{ path: '.opencode/skills/openagentsy-review/SKILL.md' }],
    });
    expect(continues(result)).toBe(false);
  });

  it('treats a call that carries content as a writer', async () => {
    const result = await decide('secret-scan-writes', {
      toolName: 'some_new_tool',
      args: { content: SECRET_CONTENT },
      files: [],
    });
    expect(continues(result)).toBe(false);
  });
});
