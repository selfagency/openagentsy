import { describe, expect, it } from 'vitest';
import { toV1Permissions, toV2Permissions, withProtectedPaths } from './permissions.js';
import type { ActionPermissions, RoleDefinition } from './types.js';

function rules(...pairs: [string, 'allow' | 'ask' | 'deny'][]): ActionPermissions {
  return pairs.map(([resource, effect]) => ({ resource, effect }));
}

function role(overrides: Partial<RoleDefinition> = {}): RoleDefinition {
  return {
    name: 'builder',
    description: 'test role',
    mode: 'subagent',
    hidden: true,
    writes: true,
    steps: 40,
    scope: 'scope',
    guidance: 'guidance',
    permissions: {},
    skills: [],
    modelProfile: { primarySignal: 'coding', hardRequirements: [], costStance: 'balanced' },
    effort: { startVariant: 'medium', ceilingVariant: 'high', climbTriggers: [] },
    ...overrides,
  };
}

describe('toV1Permissions', () => {
  it('names the shell tool bash', () => {
    const result = toV1Permissions({ shell: rules(['*', 'ask'], ['bun test*', 'allow']) });
    expect(result).toEqual({ bash: { '*': 'ask', 'bun test*': 'allow' } });
  });

  it('names the spawn tool task', () => {
    // A role that may not dispatch keeps its own deny. The shorthand form of a
    // single rule carries no catch-all, so there is nothing to rewrite.
    const result = toV1Permissions({ subagent: rules(['*', 'deny']) });
    expect(result).toEqual({ task: 'deny' });
  });

  it('writes the spawn catch-all as a double asterisk, before the named allows', () => {
    // The plugin drops a literal asterisk key from the spawn map and
    // re-appends it last, so the catch-all would beat the named allows and
    // the Task tool would leave the toolset.
    const result = toV1Permissions({
      subagent: rules(['*', 'deny'], ['oa-scout', 'allow'], ['oa-builder', 'allow']),
    });
    expect(result).toEqual({
      task: { '**': 'deny', 'oa-scout': 'allow', 'oa-builder': 'allow' },
    });
    const task = result.task as Record<string, string>;
    expect(Object.keys(task)[0]).toBe('**');
  });

  it('leaves the catch-all of another action alone', () => {
    const result = toV1Permissions({ shell: rules(['*', 'deny'], ['npm test*', 'allow']) });
    expect(result).toEqual({ bash: { '*': 'deny', 'npm test*': 'allow' } });
  });

  it('keeps the list and lsp actions', () => {
    const result = toV1Permissions({ list: rules(['*', 'allow']), lsp: rules(['*', 'allow']) });
    expect(result).toEqual({ list: 'allow', lsp: 'allow' });
  });

  it('uses the shorthand form for a single rule', () => {
    const result = toV1Permissions({ shell: rules(['*', 'ask']) });
    expect(result).toEqual({ bash: 'ask' });
  });

  it('uses the map form for several rules and keeps their order', () => {
    const result = toV1Permissions({
      shell: rules(['*', 'ask'], ['bun test*', 'allow'], ['git push*', 'deny']),
    });
    expect(result).toEqual({
      bash: { '*': 'ask', 'bun test*': 'allow', 'git push*': 'deny' },
    });
  });

  it('keeps the last effect when a resource repeats', () => {
    const result = toV1Permissions({
      edit: rules(['*', 'allow'], ['src/**', 'ask'], ['src/**', 'deny']),
    });
    expect(result).toEqual({ edit: { '*': 'allow', 'src/**': 'deny' } });
  });

  it('omits actions with no rules', () => {
    const result = toV1Permissions({ read: rules(['*', 'allow']), glob: [] });
    expect(result).toEqual({ read: 'allow' });
  });
});

describe('toV2Permissions', () => {
  it('names the shell tool shell', () => {
    const result = toV2Permissions({ shell: rules(['*', 'ask'], ['bun test*', 'allow']) });
    expect(result).toEqual([
      { action: 'shell', resource: '*', effect: 'ask' },
      { action: 'shell', resource: 'bun test*', effect: 'allow' },
    ]);
  });

  it('names the spawn tool subagent and keeps its catch-all a single asterisk', () => {
    const result = toV2Permissions({
      subagent: rules(['*', 'deny'], ['oa-scout', 'allow'], ['oa-builder', 'allow']),
    });
    expect(result).toEqual([
      { action: 'subagent', resource: '*', effect: 'deny' },
      { action: 'subagent', resource: 'oa-scout', effect: 'allow' },
      { action: 'subagent', resource: 'oa-builder', effect: 'allow' },
    ]);
  });

  it('drops the actions V2 does not have', () => {
    const result = toV2Permissions({ list: rules(['*', 'allow']), lsp: rules(['*', 'allow']) });
    expect(result).toEqual([]);
  });

  it('emits one entry per rule so the order is explicit', () => {
    const result = toV2Permissions({ shell: rules(['*', 'ask'], ['bun test*', 'allow']) });
    expect(result).toEqual([
      { action: 'shell', resource: '*', effect: 'ask' },
      { action: 'shell', resource: 'bun test*', effect: 'allow' },
    ]);
  });
});

describe('withProtectedPaths', () => {
  const protectedPaths = ['.opencode/agents/**', 'roles.yaml'];

  it('asks for the protected paths of a write-capable role', () => {
    const result = withProtectedPaths(
      role({ writes: true, permissions: { edit: rules(['*', 'allow']) } }),
      protectedPaths,
    );
    expect(result.edit).toEqual([
      { resource: '*', effect: 'allow' },
      { resource: '.opencode/agents/**', effect: 'ask' },
      { resource: 'roles.yaml', effect: 'ask' },
    ]);
  });

  it('leaves a read-only role alone', () => {
    const permissions = { edit: rules(['*', 'deny']) };
    const result = withProtectedPaths(role({ writes: false, permissions }), protectedPaths);
    expect(result).toEqual(permissions);
  });

  it('does not loosen a role whose edit is denied outright', () => {
    const result = withProtectedPaths(
      role({ writes: true, permissions: { edit: rules(['*', 'deny']) } }),
      protectedPaths,
    );
    expect(result.edit).toEqual([{ resource: '*', effect: 'deny' }]);
  });
});
