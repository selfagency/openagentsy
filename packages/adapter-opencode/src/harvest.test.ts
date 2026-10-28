import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { POLICIES } from './guard.js';
import {
  type HarvestSession,
  harvest,
  type PruneSession,
  type PruneSessionRow,
  pruneHarvestChildren,
} from './harvest.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openagentsy-harvest-'));
  await mkdir(join(root, '.openagentsy'), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A session that records what it was asked to do. */
function fakeSession(
  messages: { parts?: { type: string; text?: string }[] }[] = [],
  options: { exists?: boolean; existsError?: Error; noLookup?: boolean } = {},
) {
  const prompts: { sessionID: string; agent: string; text: string }[] = [];
  const created: { parentID?: string; title: string }[] = [];
  const existsCalls: string[] = [];
  const session: HarvestSession = {
    create: async ({ title, parentID }) => {
      created.push({ title, ...(parentID !== undefined ? { parentID } : {}) });
      return 'ses_archivist';
    },
    messages: async () => messages,
    prompt: async ({ sessionID, agent, text }) => {
      prompts.push({ sessionID, agent, text });
    },
  };
  // A runtime with no lookup to ask says so by leaving it out.
  if (options.noLookup !== true) {
    session.exists = async (sessionID: string) => {
      existsCalls.push(sessionID);
      if (options.existsError !== undefined) throw options.existsError;
      return options.exists ?? true;
    };
  }
  return { session, prompts, created, existsCalls };
}

async function writeAudit(lines: object[]): Promise<void> {
  await writeFile(
    join(root, '.openagentsy', 'audit.jsonl'),
    `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
    'utf8',
  );
}

/** The audit entries the harvest wrote, as objects. */
async function auditEntries(): Promise<
  { policyId?: string; detail?: string; resource?: string }[]
> {
  const text = await readFile(join(root, '.openagentsy', 'audit.jsonl'), 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { policyId?: string; detail?: string; resource?: string });
}

describe('harvest', () => {
  it('does not harvest the Lead, which keeps its own history', async () => {
    const { session, prompts } = fakeSession([{ parts: [{ type: 'text', text: 'hello' }] }]);
    const result = await harvest({
      session,
      root,
      sessionID: 'ses_lead',
      role: 'lead',
      agent: 'agentsy',
    });
    expect(result.harvested).toBe(false);
    expect(prompts).toHaveLength(0);
  });

  it('does not harvest the archivist, which would never stop', async () => {
    const { session, prompts } = fakeSession([{ parts: [{ type: 'text', text: 'a candidate' }] }]);
    const result = await harvest({
      session,
      root,
      sessionID: 'ses_archivist',
      role: 'archivist',
      agent: 'oa-archivist',
    });
    expect(result.harvested).toBe(false);
    expect(prompts).toHaveLength(0);
  });

  it('does not harvest a session that left nothing behind', async () => {
    const { session, prompts } = fakeSession([]);
    const result = await harvest({
      session,
      root,
      sessionID: 'ses_silent',
      role: 'scout',
      agent: 'oa-scout',
    });
    expect(result.harvested).toBe(false);
    expect(prompts).toHaveLength(0);
  });

  it('gives the archivist the transcript and the decisions of the session', async () => {
    await writeAudit([
      { sessionID: 'ses_scout', action: 'edit', resource: 'src/a.ts', effect: 'allow' },
      { sessionID: 'ses_scout', action: 'edit', resource: 'notes.md', effect: 'deny' },
      { sessionID: 'ses_other', action: 'edit', resource: 'src/b.ts', effect: 'allow' },
    ]);
    const { session, prompts } = fakeSession([
      { parts: [{ type: 'text', text: 'the lease check said no' }] },
    ]);

    const result = await harvest({
      session,
      root,
      sessionID: 'ses_scout',
      role: 'scout',
      agent: 'oa-scout',
    });

    expect(result.harvested).toBe(true);
    expect(prompts).toHaveLength(1);
    const packet = prompts[0]?.text ?? '';
    expect(prompts[0]?.agent).toBe('oa-archivist');
    expect(packet).toContain('A scout session finished');
    expect(packet).toContain('src/a.ts');
    expect(packet).toContain('notes.md');
    // The decisions of another session are not in the packet.
    expect(packet).not.toContain('src/b.ts');
    expect(packet).toContain('the lease check said no');
  });

  it('names where a candidate goes', async () => {
    // A candidate with no destination evaporates: the archivist is told to
    // save five memories and there is nowhere to save them.
    const { session, prompts } = fakeSession([{ parts: [{ type: 'text', text: 'a candidate' }] }]);
    await harvest({
      session,
      root,
      sessionID: 'ses_scout',
      role: 'scout',
      agent: 'oa-scout',
    });
    const packet = prompts[0]?.text ?? '';
    expect(packet).toContain('openagentsy_board_record');
    expect(packet).toContain('memory');
    expect(packet).toContain('at most five');
  });

  it('creates the archivist session without a parent, so it survives the harvested session', async () => {
    // The server deletes a session row without asking - a restart does -
    // and the delete cascades into the child, which cost the archivist's
    // work twice while the harvest created it as a child. The janitor finds
    // the sessions by their title, so nothing was keeping the link alive.
    const { session, created } = fakeSession([{ parts: [{ type: 'text', text: 'a candidate' }] }]);
    await harvest({
      session,
      root,
      sessionID: 'ses_scout',
      role: 'scout',
      agent: 'oa-scout',
    });
    expect(created).toHaveLength(1);
    expect(created[0]?.parentID).toBeUndefined();
  });

  it('asks the server that the archivist session exists before prompting it', async () => {
    const { session, prompts, existsCalls } = fakeSession([
      { parts: [{ type: 'text', text: 'a candidate' }] },
    ]);
    const result = await harvest({
      session,
      root,
      sessionID: 'ses_scout',
      role: 'scout',
      agent: 'oa-scout',
    });
    expect(result.harvested).toBe(true);
    expect(existsCalls).toEqual(['ses_archivist']);
    expect(prompts).toHaveLength(1);
  });

  it('does not prompt an archivist session that was deleted, and records the failure', async () => {
    // The parent is gone, so the cascading delete took the child with it. The
    // prompt's message insert would fail the foreign key instead of reaching
    // the archivist.
    const { session, prompts, existsCalls } = fakeSession(
      [{ parts: [{ type: 'text', text: 'a candidate' }] }],
      { exists: false },
    );
    const result = await harvest({
      session,
      root,
      sessionID: 'ses_scout',
      role: 'scout',
      agent: 'oa-scout',
    });
    expect(result.harvested).toBe(false);
    expect(result.reason).toContain('no longer exists');
    expect(existsCalls).toEqual(['ses_archivist']);
    expect(prompts).toHaveLength(0);

    const failure = (await auditEntries()).find(
      (entry) => entry.policyId === POLICIES.harvestFailed.id,
    );
    expect(failure?.detail).toContain('ses_archivist');
    expect(failure?.resource).toBe('ses_scout');
  });

  it('prompts the archivist when the runtime has no lookup to ask', async () => {
    // The V2 plugin context cannot look a session up, so the adapter leaves
    // the lookup out. The harvest says so on the record and goes on: the
    // archivist stands on its own, so there is no cascade to survive.
    const { session, prompts, existsCalls } = fakeSession(
      [{ parts: [{ type: 'text', text: 'a candidate' }] }],
      { noLookup: true },
    );
    const result = await harvest({
      session,
      root,
      sessionID: 'ses_scout',
      role: 'scout',
      agent: 'oa-scout',
    });
    expect(result.harvested).toBe(true);
    expect(existsCalls).toEqual([]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.sessionID).toBe('ses_archivist');
  });

  it('records a failure instead of prompting when the runtime cannot answer', async () => {
    // Guessing is the bug: an empty message list cannot tell a fresh session
    // from a deleted one, so a runtime that cannot answer states that it
    // cannot confirm, and the harvest records that without prompting.
    await writeAudit([
      { sessionID: 'ses_scout', action: 'edit', resource: 'src/a.ts', effect: 'allow' },
    ]);
    const { session, prompts } = fakeSession([], {
      existsError: new Error('the runtime cannot confirm that a session still exists'),
    });
    const result = await harvest({
      session,
      root,
      sessionID: 'ses_scout',
      role: 'scout',
      agent: 'oa-scout',
    });
    expect(result.harvested).toBe(false);
    expect(result.reason).toContain('cannot confirm');
    expect(prompts).toHaveLength(0);
    const failure = (await auditEntries()).find(
      (entry) => entry.policyId === POLICIES.harvestFailed.id,
    );
    expect(failure?.detail).toContain('cannot confirm');
  });
});

const DAY = 24 * 60 * 60 * 1000;

/** A session runtime whose list and delete are the janitor's only answers. */
function janitor(
  rows: PruneSessionRow[],
  options: { failDelete?: string } = {},
): { session: PruneSession; deleted: string[] } {
  const deleted: string[] = [];
  const session: PruneSession = {
    list: async () => rows,
    delete: async (sessionID) => {
      if (options.failDelete === sessionID) {
        throw new Error(`delete ${sessionID} was refused`);
      }
      deleted.push(sessionID);
    },
  };
  return { session, deleted };
}

describe('the harvest janitor', () => {
  const now = Date.now();

  it('deletes a harvest child older than seven days and keeps every other session', async () => {
    const { session, deleted } = janitor([
      {
        id: 'ses_old',
        title: 'harvest scout',
        agent: 'oa-archivist',
        time: { created: now - 8 * DAY },
      },
      {
        id: 'ses_recent',
        title: 'harvest scout',
        agent: 'oa-archivist',
        time: { created: now - DAY },
      },
      {
        id: 'ses_foreign',
        title: 'Prune the adapter',
        agent: 'oa-archivist',
        time: { created: now - 30 * DAY },
      },
      {
        id: 'ses_other_agent',
        title: 'harvest scout',
        agent: 'oa-builder',
        time: { created: now - 30 * DAY },
      },
      {
        id: 'ses_unreported_agent',
        title: 'harvest OpenCoder',
        time: { created: now - 30 * DAY },
      },
    ]);

    await pruneHarvestChildren(session, root, now);

    expect(deleted).toEqual(['ses_old']);
  });

  it('records a failed delete without breaking the harvest', async () => {
    const { session } = janitor(
      [
        {
          id: 'ses_old',
          title: 'harvest scout',
          agent: 'oa-archivist',
          time: { created: now - 8 * DAY },
        },
      ],
      { failDelete: 'ses_old' },
    );
    const fake = fakeSession([{ parts: [{ type: 'text', text: 'a candidate' }] }]);
    let pruning: Promise<void> | undefined;
    const harvestSession: HarvestSession = {
      ...fake.session,
      prune: () => {
        pruning = pruneHarvestChildren(session, root, now);
        return pruning;
      },
    };

    const result = await harvest({
      session: harvestSession,
      root,
      sessionID: 'ses_scout',
      role: 'scout',
      agent: 'oa-scout',
    });
    await pruning;

    expect(result.harvested).toBe(true);
    const failure = (await auditEntries()).find(
      (entry) => entry.policyId === POLICIES.harvestFailed.id,
    );
    expect(failure?.detail).toContain('harvest prune failed');
    expect(failure?.detail).toContain('ses_old');
  });
});
