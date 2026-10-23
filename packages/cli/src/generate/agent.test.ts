import { agentIdFor, agentIdOf, parseRoles, type RolesFile } from '@openagentsy/core';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { agentFileName, renderAgent } from './agent.js';
import { COMMANDS, renderCommand } from './commands.js';

const ROLES = `
version: 1
protectedPaths:
  - "roles.yaml"
defaults:
  permissions:
    read:
      - resource: "*"
        effect: allow
    external_directory:
      - resource: "*"
        effect: ask
roles:
  lead:
    description: Plans and delegates
    mode: primary
    writes: false
    scope: the plan
    guidance: classify first
    permissions:
      shell:
        - resource: "*"
          effect: ask
        - resource: "git status*"
          effect: allow
      subagent:
        - resource: "*"
          effect: deny
        - resource: "oa-scout"
          effect: allow
    skills: []
    modelProfile:
      primarySignal: agentic
      hardRequirements: [tool_calls]
      costStance: quality_first
    effort:
      startVariant: medium
      ceilingVariant: xhigh
      climbTriggers: [planning]
  builder:
    description: Implements a bean
    mode: subagent
    hidden: true
    writes: true
    steps: 40
    scope: only leased files
    guidance: test the change
    permissions:
      edit:
        - resource: "*"
          effect: allow
      shell:
        - resource: "*"
          effect: ask
        - resource: "git push*"
          effect: deny
    skills: [openagentsy-handoff]
    modelProfile:
      primarySignal: coding
      hardRequirements: [tool_calls]
      costStance: balanced
    effort:
      startVariant: medium
      ceilingVariant: high
      climbTriggers: [test_failed_twice]
  reviewer:
    description: Reviews a diff
    mode: subagent
    hidden: false
    writes: false
    steps: 20
    scope: the diff
    guidance: report findings
    permissions:
      edit: deny
      openagentsy_board_lease_grant: deny
      openagentsy_board_lease_revoke: deny
    skills: []
    modelProfile:
      primarySignal: coding
      hardRequirements: [tool_calls]
      costStance: balanced
    effort:
      startVariant: low
      ceilingVariant: high
      climbTriggers: []
`;

function roles(): RolesFile {
  return parseRoles(ROLES);
}

function frontmatter(markdown: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  if (!match) throw new Error('no frontmatter found');
  const yaml = match[1];
  if (yaml === undefined) throw new Error('no frontmatter found');
  return parseYaml(yaml) as Record<string, unknown>;
}

/** A role the test knows exists. */
function role(file: RolesFile, name: string): RolesFile['roles'][string] {
  const found = file.roles[name];
  if (!found) throw new Error(`no role ${name}`);
  return found;
}

describe('renderAgent for V1', () => {
  it('writes a permission map', () => {
    const file = roles();
    const markdown = renderAgent(role(file, 'builder'), file, { target: 'v1' });
    const meta = frontmatter(markdown);
    expect(meta.permission).toBeDefined();
    expect(meta.permissions).toBeUndefined();
  });

  it('names an agent after its role when no agent name is given', () => {
    const file = roles();
    expect(agentFileName(role(file, 'builder'))).toBe('oa-builder.md');
  });

  it('names an agent by its own agent name when the role carries one', () => {
    const file = roles();
    const lead = { ...role(file, 'lead'), agentName: 'agentsy' };
    expect(agentFileName(lead)).toBe('agentsy.md');
  });

  it('names the spawn tool task', () => {
    const file = roles();
    const meta = frontmatter(renderAgent(role(file, 'lead'), file, { target: 'v1' }));
    const permission = meta.permission as Record<string, unknown>;
    expect(permission.task).toEqual({ '*': 'deny', 'oa-scout': 'allow' });
  });

  it('asks for the protected paths of a write-capable role', () => {
    const file = roles();
    const meta = frontmatter(renderAgent(role(file, 'builder'), file, { target: 'v1' }));
    const permission = meta.permission as Record<string, Record<string, string>>;
    expect(permission.edit).toEqual({ '*': 'allow', 'roles.yaml': 'ask' });
  });

  it('omits the model when there is no lock file', () => {
    const file = roles();
    const meta = frontmatter(renderAgent(role(file, 'builder'), file, { target: 'v1' }));
    expect(meta.model).toBeUndefined();
  });

  it('writes the model when the lock file provides one', () => {
    const file = roles();
    const meta = frontmatter(
      renderAgent(role(file, 'builder'), file, { target: 'v1', model: 'opencode/kimi-k3' }),
    );
    expect(meta.model).toBe('opencode/kimi-k3');
  });
});

describe('renderAgent for V2', () => {
  it('writes an ordered permission list', () => {
    const file = roles();
    const meta = frontmatter(renderAgent(role(file, 'builder'), file, { target: 'v2' }));
    expect(meta.permissions).toBeInstanceOf(Array);
    expect(meta.permission).toBeUndefined();
  });

  it('names the spawn tool subagent', () => {
    const file = roles();
    const meta = frontmatter(renderAgent(role(file, 'lead'), file, { target: 'v2' }));
    const permissions = meta.permissions as {
      action: string;
      resource: string;
      effect: string;
    }[];
    expect(permissions).toContainEqual({ action: 'subagent', resource: '*', effect: 'deny' });
    expect(permissions).toContainEqual({
      action: 'subagent',
      resource: 'oa-scout',
      effect: 'allow',
    });
  });

  it('pins the starting variant in the model', () => {
    const file = roles();
    const meta = frontmatter(
      renderAgent(role(file, 'builder'), file, {
        target: 'v2',
        model: 'opencode/kimi-k3',
        modelVariant: 'medium',
      }),
    );
    expect(meta.model).toBe('opencode/kimi-k3#medium');
  });

  it('leaves out the list and lsp actions V2 does not have', () => {
    const file = roles();
    const meta = frontmatter(renderAgent(role(file, 'builder'), file, { target: 'v2' }));
    const permissions = meta.permissions as { action: string }[];
    const actions = new Set(permissions.map((rule) => rule.action));
    expect(actions.has('list')).toBe(false);
    expect(actions.has('lsp')).toBe(false);
  });
});

describe('the agent body', () => {
  it('carries the scope, the guidance and the reporting format', () => {
    const file = roles();
    const markdown = renderAgent(role(file, 'builder'), file, { target: 'v1' });
    expect(markdown).toContain('only leased files');
    expect(markdown).toContain('test the change');
    expect(markdown).toContain('confidence');
  });

  it('names the climb triggers of the role', () => {
    const file = roles();
    const markdown = renderAgent(role(file, 'builder'), file, { target: 'v1' });
    expect(markdown).toContain('test_failed_twice');
  });
});

describe('renderCommand', () => {
  it('uses subtask for V1 and subagent for V2', () => {
    const command = COMMANDS.find((entry) => entry.name === 'review');
    if (!command) throw new Error('no review command');
    const v1 = frontmatter(renderCommand(command, 'v1', 'oa-reviewer'));
    const v2 = frontmatter(renderCommand(command, 'v2', 'oa-reviewer'));
    expect(v1.subtask).toBe(true);
    expect(v1.subagent).toBeUndefined();
    expect(v2.subagent).toBe(true);
    expect(v2.subtask).toBeUndefined();
  });

  it('points each command at its agent', () => {
    const command = COMMANDS.find((entry) => entry.name === 'review');
    if (!command) throw new Error('no review command');
    expect(frontmatter(renderCommand(command, 'v1', 'oa-reviewer')).agent).toBe('oa-reviewer');
  });

  it('names a role, so a renamed role renames the command', () => {
    const file = roles();
    for (const command of COMMANDS) {
      const role = file.roles[command.role];
      if (!role) throw new Error(`no role "${command.role}" for the ${command.name} command`);
      expect(agentIdFor(file, command.role)).toBe(agentIdOf(role));
    }
  });
});

describe('the generated prompts', () => {
  it('names no tool that a default install does not register', () => {
    // The scout used to be told to prefer AFT tools that setup never
    // registers, so a literal scout looked for them and found nothing.
    const file = roles();
    for (const name of Object.keys(file.roles)) {
      const markdown = renderAgent(role(file, name), file, { target: 'v1' });
      const mentions = markdown.match(/\b(aft_[a-z_]+)\b/g) ?? [];
      for (const tool of mentions) {
        // The mention is allowed when it is conditional: "when the AFT
        // tools are registered" names a tool that may not be there.
        const conditional = markdown.includes('When the AFT tools are registered');
        expect(conditional, `${name} names ${tool} without saying it may be absent`).toBe(true);
      }
    }
  });

  it('gives the lease revoke to the Lead alone', () => {
    // The board cannot verify who is calling it, so the permission map
    // decides. Every other role has the tool denied by name.
    const file = roles();
    const lead = frontmatter(renderAgent(role(file, 'lead'), file, { target: 'v1' }));
    const reviewer = frontmatter(renderAgent(role(file, 'reviewer'), file, { target: 'v1' }));
    const leadPermission = lead.permission as Record<string, unknown>;
    const reviewerPermission = reviewer.permission as Record<string, unknown>;
    expect(leadPermission.openagentsy_board_lease_revoke).toBeUndefined();
    expect(reviewerPermission.openagentsy_board_lease_revoke).toBe('deny');
  });
});
