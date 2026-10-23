import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type HarvestClient, harvest } from './harvest.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openagentsy-harvest-'));
  await mkdir(join(root, '.openagentsy'), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A client that records what it was asked to do. */
function fakeClient(messages: { parts?: { type: string; text?: string }[] }[] = []) {
  const prompts: { sessionID: string; agent: string; text: string }[] = [];
  const created: { parentID?: string; title: string }[] = [];
  const client: HarvestClient = {
    session: {
      create: async (options) => {
        created.push({
          ...(options.body.parentID !== undefined ? { parentID: options.body.parentID } : {}),
          title: options.body.title,
        });
        return { data: { id: 'ses_archivist' } };
      },
      messages: async () => ({ data: messages }),
      promptAsync: async (options) => {
        prompts.push({
          sessionID: options.path.id,
          agent: options.body.agent ?? 'unknown',
          text: options.body.parts[0]?.text ?? '',
        });
        return {};
      },
    },
  };
  return { client, prompts, created };
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
    const { client, prompts } = fakeClient([{ parts: [{ type: 'text', text: 'hello' }] }]);
    const result = await harvest({
      client,
      root,
      directory: root,
      sessionID: 'ses_lead',
      role: 'lead',
      agent: 'agentsy',
    });
    expect(result.harvested).toBe(false);
    expect(prompts).toHaveLength(0);
  });

  it('does not harvest the archivist, which would never stop', async () => {
    const { client, prompts } = fakeClient([{ parts: [{ type: 'text', text: 'a candidate' }] }]);
    const result = await harvest({
      client,
      root,
      directory: root,
      sessionID: 'ses_archivist',
      role: 'archivist',
      agent: 'oa-archivist',
    });
    expect(result.harvested).toBe(false);
    expect(prompts).toHaveLength(0);
  });

  it('does not harvest a session that left nothing behind', async () => {
    const { client, prompts } = fakeClient([]);
    const result = await harvest({
      client,
      root,
      directory: root,
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
    const { client, prompts } = fakeClient([
      { parts: [{ type: 'text', text: 'the lease check said no' }] },
    ]);

    const result = await harvest({
      client,
      root,
      directory: root,
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

  it('creates the archivist session as a child of the session it harvests', async () => {
    const { client, created } = fakeClient([{ parts: [{ type: 'text', text: 'a candidate' }] }]);
    await harvest({
      client,
      root,
      directory: root,
      sessionID: 'ses_scout',
      role: 'scout',
      agent: 'oa-scout',
    });
    expect(created).toHaveLength(1);
    expect(created[0]?.parentID).toBe('ses_scout');
  });
});
