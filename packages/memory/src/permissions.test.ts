import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { toV2Permissions, withProtectedPaths } from '@openagentsy/core';
import { describe, expect, it } from 'vitest';
import { loadRealRoles, repositoryRoot } from './fixtures.js';

/**
 * The permission map is the enforcement.
 *
 * The hook cannot see an MCP call on the pinned binary, so the map is what
 * stops an agent from deciding what is kept. The map has to carry the deny
 * under both of the names the tool is called by: the bare name, and the
 * name the MCP server publishes it under.
 */
const DECIDE_NAMES = ['oa_memory_decide', 'openagentsy_memory_decide'] as const;

/** Whether a generated prompt denies a tool. */
function deniesTool(content: string, tool: string): boolean {
  if (new RegExp(`^\\s*${tool}: deny$`, 'm').test(content)) return true;
  return new RegExp(`action: ${tool}\\n\\s+resource: [^\\n]*\\n\\s+effect: deny`).test(content);
}

describe('the permission map and the decide tool', () => {
  it('denies the decide tool to every role, under both of its names', async () => {
    const roles = await loadRealRoles();
    const names = Object.keys(roles.roles);
    expect(names.length).toBeGreaterThan(0);

    for (const name of names) {
      const role = roles.roles[name];
      if (role === undefined) continue;
      const rules = toV2Permissions(withProtectedPaths(role, roles.protectedPaths));
      for (const tool of DECIDE_NAMES) {
        expect(rules).toContainEqual({ action: tool, resource: '*', effect: 'deny' });
      }
    }
  });

  it('carries the deny into every generated agent', async () => {
    const dir = join(repositoryRoot, '.opencode', 'agents');
    // The generated files are not in the repository: they are written by
    // `openagentsy build`, and a checkout that never ran it has none.
    if (!existsSync(dir)) return;

    const files = (await readdir(dir)).filter((file) => file.endsWith('.md'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = await readFile(join(dir, file), 'utf8');
      for (const tool of DECIDE_NAMES) {
        expect(deniesTool(content, tool)).toBe(true);
      }
    }
  });
});
