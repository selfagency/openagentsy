import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
function fakeSession(messages: { parts?: { type: string; text?: string }[] }[] = []) {
  const prompts: { sessionID: string; agent: string; text: string }[] = [];
  const created: { parentID?: string; title: string }[] = [];
  const session: HarvestSession = {
    create: async ({ title, parentID }) => {
      created.push({ parentID, title });
      return 'ses_archivist';
    },
    messages: async () => messages,
    prompt: async ({ sessionID, agent, text }) => {
      prompts.push({ sessionID, agent, text });
    },
  };
  return { session, prompts, created };
}

async function writeAudit(lines: object[]): Promise<void> {
  await writeFile(
    join(root, '.openagentsy', 'audit.jsonl'),
    lines.map((line) => JSON.stringify(line)).join('\n'),
    'utf8',
  );
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
});
