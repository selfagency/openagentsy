import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { toV2Permissions, withProtectedPaths } from '@openagentsy/core';
import { describe, expect, it } from 'vitest';
import {
  candidateRecord,
  fakeReader,
  loadRealRoles,
  repositoryRoot,
  temporaryRoot,
} from './fixtures.js';
import { MemoryInbox } from './inbox.js';
import * as memory from './index.js';
import { MemoryStore } from './store.js';
import { createMemoryTools } from './tools.js';

const ctx = { sessionID: 'test-session', agent: 'oa-builder' };

/** Every file under a directory, so a skill's own folder is read too. */
async function promptFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await promptFiles(path)));
    else files.push(path);
  }
  return files;
}

/** The two names the decide tool is called by. */
const DECIDE_NAMES = ['oa_memory_decide', 'openagentsy_memory_decide'] as const;

/**
 * The prompt body, without the frontmatter.
 *
 * The frontmatter carries the permission map, and the permission map may
 * name a tool: the agent is allowed to search. What the exit test is
 * about is a prompt that calls it, so the frontmatter is not the text
 * under test.
 */
function promptBody(content: string): string {
  if (!content.startsWith('---')) return content;
  const lines = content.split('\n');
  const end = lines.indexOf('---', 1);
  return end === -1 ? content : lines.slice(end + 1).join('\n');
}

describe('§4.6 the exit tests', () => {
  it('1. a candidate a person approved is found by a term in its text', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      const record = candidateRecord({
        id: 7,
        action: 'The lease guard refuses a write to a file no lease covers.',
      });
      const records = [record];
      const store = new MemoryStore({ root });
      const inbox = new MemoryInbox({ root, read: fakeReader(records), store });
      const tools = createMemoryTools({ store, inbox });

      const decision = await inbox.decide(7, 'approve', 'daniel');
      expect(decision.ok).toBe(true);

      const path = join(root, '.openagentsy', 'memory.jsonl');
      expect(existsSync(path)).toBe(true);
      const lines = (await readFile(path, 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(1);

      const found = (await tools.oa_memory_search.execute({ q: 'lease' }, ctx)) as {
        hits: { id: string }[];
      };
      expect(found.hits).toHaveLength(1);

      const shown = (await tools.oa_memory_search.execute(
        { q: 'lease', includeUnverified: true },
        ctx,
      )) as { hits: { text: string }[] };
      expect(shown.hits[0]?.text).toContain('lease guard');
    } finally {
      await remove();
    }
  });

  it('2. a rejected candidate never enters the store, and its record says rejected', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      const records = [candidateRecord({ id: 7 })];
      const store = new MemoryStore({ root });
      const inbox = new MemoryInbox({ root, read: fakeReader(records), store });

      const decision = await inbox.decide(7, 'reject', 'daniel');
      expect(decision.ok).toBe(true);
      expect(await store.entries()).toEqual([]);
      expect(existsSync(join(root, '.openagentsy', 'memory.jsonl'))).toBe(false);
      expect(records[0]?.state).toBe('rejected');
    } finally {
      await remove();
    }
  });

  it('3. the permission map alone blocks the decide tool, under both of its names', async () => {
    const roles = await loadRealRoles();
    const names = Object.keys(roles.roles);
    expect(names.length).toBeGreaterThan(0);

    for (const name of names) {
      const role = roles.roles[name];
      if (role === undefined) continue;
      const permissions = toV2Permissions(withProtectedPaths(role, roles.protectedPaths));
      for (const tool of DECIDE_NAMES) {
        expect(permissions).toContainEqual({ action: tool, resource: '*', effect: 'deny' });
      }
    }
  });

  it('4. a seeded secret never reaches the store, and the count comes back', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      const seeded = 'AKIAIOSFODNN7EXAMPLE';
      const records = [
        candidateRecord({
          id: 7,
          action: `The deploy key is ${seeded} and it must not be kept.`,
        }),
      ];
      const store = new MemoryStore({ root });
      const inbox = new MemoryInbox({ root, read: fakeReader(records), store });

      const decision = await inbox.decide(7, 'approve', 'daniel');
      expect(decision.ok).toBe(true);
      if (!decision.ok) return;
      expect(decision.redactions).toBe(1);

      const written = await readFile(join(root, '.openagentsy', 'memory.jsonl'), 'utf8');
      expect(written).not.toContain(seeded);
    } finally {
      await remove();
    }
  });

  it('5. the package injects nothing into a prompt, and no prompt calls the search', async () => {
    const exported = Object.keys(memory);
    expect(exported.filter((name) => /transform|system|prime/i.test(name))).toEqual([]);

    for (const dir of ['agents', 'commands', 'skills']) {
      const path = join(repositoryRoot, '.opencode', dir);
      if (!existsSync(path)) continue;
      for (const file of await promptFiles(path)) {
        const content = await readFile(file, 'utf8');
        // The permission map may name the tool: the agent is allowed to
        // search. What must not happen is a prompt that calls it.
        expect(promptBody(content)).not.toContain('oa_memory_search');
      }
    }
  });
});
