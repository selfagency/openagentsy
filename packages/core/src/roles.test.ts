import { describe, expect, it } from 'vitest';
import { parseRoles, RolesError } from './roles.js';
import type { RolesFile } from './types.js';

const MINIMAL = `
version: 1
protectedPaths:
  - "roles.yaml"
defaults:
  steps: 40
  permissions:
    read:
      - resource: "*"
        effect: allow
    webfetch: ask
roles:
  builder:
    description: Implements a bean
    mode: subagent
    writes: true
    scope: only leased files
    guidance: test the change
    permissions:
      edit:
        - resource: "*"
          effect: allow
      shell:
        - resource: "*"
          effect: ask
    skills: [openagentsy-handoff]
    modelProfile:
      primarySignal: coding
      hardRequirements: [tool_calls]
      costStance: balanced
    effort:
      startVariant: medium
      ceilingVariant: high
      climbTriggers: [test_failed_twice]
`;

/** A role the test knows exists. */
function role(roles: RolesFile, name: string): RolesFile['roles'][string] {
  const found = roles.roles[name];
  if (!found) throw new Error(`no role ${name}`);
  return found;
}

describe('parseRoles', () => {
  it('reads a role definition', () => {
    const roles = parseRoles(MINIMAL);
    const builder = role(roles, 'builder');
    expect(builder.description).toBe('Implements a bean');
    expect(builder.mode).toBe('subagent');
    expect(builder.writes).toBe(true);
    expect(builder.steps).toBe(40);
  });

  it('merges the default permissions into the role', () => {
    const roles = parseRoles(MINIMAL);
    const builder = role(roles, 'builder');
    expect(builder.permissions.read).toEqual([{ resource: '*', effect: 'allow' }]);
    expect(builder.permissions.webfetch).toEqual([{ resource: '*', effect: 'ask' }]);
  });

  it('lets the role override a default action', () => {
    const roles = parseRoles(MINIMAL);
    const builder = role(roles, 'builder');
    expect(builder.permissions.edit).toEqual([{ resource: '*', effect: 'allow' }]);
  });

  it('derives the skill permission from the skill list', () => {
    const roles = parseRoles(MINIMAL);
    const builder = role(roles, 'builder');
    expect(builder.permissions.skill).toEqual([
      { resource: '*', effect: 'deny' },
      { resource: 'openagentsy-handoff', effect: 'allow' },
    ]);
  });

  it('allows every skill when the list is empty', () => {
    const roles = parseRoles(MINIMAL.replace('skills: [openagentsy-handoff]', 'skills: []'));
    expect(roles.roles.builder?.permissions.skill).toEqual([{ resource: '*', effect: 'allow' }]);
  });

  it('reads the model profile and the effort ladder', () => {
    const roles = parseRoles(MINIMAL);
    const builder = role(roles, 'builder');
    expect(builder.modelProfile.primarySignal).toBe('coding');
    expect(builder.modelProfile.costStance).toBe('balanced');
    expect(builder.effort.climbTriggers).toEqual(['test_failed_twice']);
  });

  it('rejects an unknown action', () => {
    const broken = MINIMAL.replace('      shell:', '      telepathy:');
    expect(() => parseRoles(broken)).toThrow(RolesError);
    expect(() => parseRoles(broken)).toThrow(/unknown action/);
  });

  it('rejects an unknown permission effect', () => {
    const broken = MINIMAL.replace('effect: allow', 'effect: maybe');
    expect(() => parseRoles(broken)).toThrow(/expected one of/);
  });

  it('rejects a missing required field', () => {
    const broken = MINIMAL.replace('    scope: only leased files\n', '');
    expect(() => parseRoles(broken)).toThrow(/scope/);
  });

  it('rejects an unsupported version', () => {
    expect(() => parseRoles(MINIMAL.replace('version: 1', 'version: 2'))).toThrow(/version/);
  });

  it('rejects a file with no roles', () => {
    const broken = MINIMAL.replace(/roles:\n {2}builder:[\s\S]*$/, 'roles: {}\n');
    expect(() => parseRoles(broken)).toThrow(/at least one role/);
  });
});
