import { join } from 'node:path';
import { toV2Permissions } from '@openagentsy/core';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { caseRoles, judgeAgent, SESSION_MOVE_TOOL } from './fixture.js';
import type { OpenCodeRuntime } from './opencode.js';

const REPO_ROOT = process.env.OPENAGENTSY_REPO_ROOT ?? join(import.meta.dirname, '..', '..', '..');

const RUNTIME: OpenCodeRuntime = { binary: 'opencode', version: '2.2.0', major: 2 };

/** The rule that keeps a session inside the case directory. */
const DENY = { action: 'opencode_session_move', resource: '*', effect: 'deny' };

/**
 * The roles a case runs under, as the harness writes them.
 */
async function rolesOf(headless: boolean): Promise<Record<string, { permissions?: unknown }>> {
  const text = await caseRoles(REPO_ROOT, headless);
  const parsed = parse(text) as { roles: Record<string, { permissions?: unknown }> };
  return parsed.roles;
}

describe('the roles of a case', () => {
  it('deny the session-moving tool to every role', async () => {
    // A session that leaves the case directory loses its agent: the server
    // resolves an agent in the directory of the session. The board, the
    // leases and the harvest live in the case directory too, so an agent of
    // a case may not move its session out of it.
    const roles = await rolesOf(true);
    const names = Object.keys(roles);
    expect(names.length).toBeGreaterThan(0);
    for (const [name, role] of Object.entries(roles)) {
      const permissions = role.permissions as Record<string, unknown> | undefined;
      expect(permissions?.[SESSION_MOVE_TOOL], name).toEqual([{ resource: '*', effect: 'deny' }]);
    }
  });

  it('deny it whether the case is headless or not', async () => {
    // The deny is the case's own rule and not the headless opening: a case
    // that is not headless is still a closed world.
    const roles = await rolesOf(false);
    for (const [name, role] of Object.entries(roles)) {
      const permissions = role.permissions as Record<string, unknown> | undefined;
      expect(permissions?.[SESSION_MOVE_TOOL], name).toEqual([{ resource: '*', effect: 'deny' }]);
    }
  });

  it('write the deny as the rule the server matches', () => {
    // The host calls the tool `opencode_session_move`: a namespaced tool
    // reaches the model with the namespace in front of the name and an
    // underscore between. The rule has to carry that name, or it names a
    // tool the host does not have.
    const rules = toV2Permissions({ [SESSION_MOVE_TOOL]: [{ resource: '*', effect: 'deny' }] });
    expect(rules).toContainEqual(DENY);
  });

  it('deny it to the judge as well', async () => {
    // The judge is not a role, so the roles do not cover it, and the judge
    // runs in the case directory like every other agent of the case.
    const file = await judgeAgent(REPO_ROOT, RUNTIME);
    const frontmatter = parse(file.slice(4, file.indexOf('\n---', 3))) as {
      permissions?: { action: string; resource: string; effect: string }[];
    };
    expect(frontmatter.permissions).toContainEqual(DENY);
  });
});
