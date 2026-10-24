import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type SessionClient, sessionAdapter } from './client.js';
import { POLICIES } from './guard.js';
import { type HarvestSession, harvest } from './harvest.js';

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
  options: { exists?: boolean; existsError?: Error } = {},
) {
  const prompts: { sessionID: string; agent: string; text: string }[] = [];
  const created: { parentID?: string; title: string }[] = [];
  const existsCalls: string[] = [];
  const session: HarvestSession = {
    create: async ({ title, parentID }) => {
      created.push({ parentID, title });
      return 'ses_archivist';
    },
    messages: async () => messages,
    exists: async (sessionID: string) => {
      existsCalls.push(sessionID);
      if (options.existsError !== undefined) throw options.existsError;
      return options.exists ?? true;
    },
    prompt: async ({ sessionID, agent, text }) => {
      prompts.push({ sessionID, agent, text });
    },
  };
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

  it('creates the archivist session as a child of the session it harvests', async () => {
    const { session, created } = fakeSession([{ parts: [{ type: 'text', text: 'a candidate' }] }]);
    await harvest({
      session,
      root,
      sessionID: 'ses_scout',
      role: 'scout',
      agent: 'oa-scout',
    });
    expect(created).toHaveLength(1);
    expect(created[0]?.parentID).toBe('ses_scout');
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

/** A client whose lookup is the only part that answers. */
function fakeClient(get: SessionClient['get'], overrides: Partial<SessionClient> = {}) {
  return {
    session: {
      get,
      create: async () => ({}),
      messages: async () => ({}),
      promptAsync: async () => ({}),
      list: async () => ({}),
      delete: async () => ({}),
      ...overrides,
    },
  };
}

describe('the V1 session adapter', () => {
  it('answers that a session exists when the server returns it', async () => {
    const session = sessionAdapter(
      fakeClient(async () => ({ data: { id: 'ses_1' } })),
      root,
    );
    await expect(session.exists('ses_1')).resolves.toBe(true);
  });

  it('answers that a session is gone when the server says not found', async () => {
    const session = sessionAdapter(
      fakeClient(async () => ({ error: { name: 'NotFoundError' } })),
      root,
    );
    await expect(session.exists('ses_1')).resolves.toBe(false);
  });

  it('answers that a session is gone when a wrapped error carries not found under cause', async () => {
    // `throwOnError` wraps the parsed body in a plain Error: the outer name
    // is 'Error', and the body the SDK returned sits at cause.body.
    const wrapped = new Error('not found', {
      cause: { body: { name: 'NotFoundError' }, status: 404 },
    });
    const session = sessionAdapter(
      fakeClient(async () => {
        throw wrapped;
      }),
      root,
    );
    await expect(session.exists('ses_1')).resolves.toBe(false);
  });

  it('does not report an unrelated error as present', async () => {
    const session = sessionAdapter(
      fakeClient(async () => ({ error: { name: 'BadRequest' } })),
      root,
    );
    await expect(session.exists('ses_1')).rejects.toThrow('BadRequest');
  });
});

const DAY = 24 * 60 * 60 * 1000;

/** A client whose list and delete are the janitor's only answers. */
function janitorClient(
  rows: { id: string; title: string; agent?: string; time?: { created?: number } }[],
  options: { failDelete?: string; missingDelete?: string } = {},
) {
  const deleted: string[] = [];
  const client = fakeClient(async () => ({ data: { id: 'ses_1' } }), {
    list: async () => ({ data: rows }),
    delete: async ({ path }) => {
      if (options.failDelete === path.id) throw new Error(`delete ${path.id} was refused`);
      if (options.missingDelete === path.id) return { error: { name: 'NotFoundError' } };
      deleted.push(path.id);
      return { data: true };
    },
  });
  return { client, deleted };
}

describe('the harvest janitor', () => {
  const now = Date.now();

  it('deletes a harvest child older than seven days and keeps every other session', async () => {
    const { client, deleted } = janitorClient([
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

    await sessionAdapter(client, root).prune?.();

    expect(deleted).toEqual(['ses_old']);
  });

  it('treats a session the server no longer has as already pruned', async () => {
    const { client, deleted } = janitorClient(
      [
        {
          id: 'ses_gone',
          title: 'harvest scout',
          agent: 'oa-archivist',
          time: { created: now - 8 * DAY },
        },
      ],
      { missingDelete: 'ses_gone' },
    );

    await expect(sessionAdapter(client, root).prune?.()).resolves.toBeUndefined();
    expect(deleted).toHaveLength(0);
    expect(await auditEntries()).toHaveLength(0);
  });

  it('records a failed delete without breaking the harvest', async () => {
    const { client } = janitorClient(
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
    const adapter = sessionAdapter(client, root);
    const fake = fakeSession([{ parts: [{ type: 'text', text: 'a candidate' }] }]);
    let pruning: Promise<void> | undefined;
    const session: HarvestSession = {
      ...fake.session,
      prune: () => {
        pruning = adapter.prune?.() ?? Promise.resolve();
        return pruning;
      },
    };

    const result = await harvest({
      session,
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
