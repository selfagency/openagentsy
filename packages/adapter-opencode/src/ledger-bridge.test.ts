import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, grantLeases, migrate, openDatabase } from '@openagentsy/core';
import { closeLedger, openLedger, perTaskTotals } from '@openagentsy/ledger';
import { afterEach, describe, expect, it } from 'vitest';
import { assistantMessageOf, bridgeToLedger } from './ledger-bridge.js';
import type { Roots } from './roots.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** An assistant message in the shape the host hands it over. */
const assistant = {
  id: 'msg-1',
  sessionID: 'ses-1',
  role: 'assistant',
  time: { created: 1, completed: 2 },
  providerID: 'anthropic',
  modelID: 'claude-sonnet',
  cost: 0.1,
  tokens: { input: 100, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
};

/** A project root with a board, and a lease for the agent when it has one. */
async function rootWith(lease?: { bean: string; agent: string }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'oa-bridge-'));
  roots.push(root);
  const stateDir = join(root, '.openagentsy');
  await mkdir(stateDir, { recursive: true });
  const db = openDatabase(join(stateDir, 'board.sqlite'));
  try {
    migrate(db);
    if (lease !== undefined) {
      grantLeases(db, { bean: lease.bean, agent: lease.agent, globs: ['**'] });
    }
  } finally {
    closeDatabase(db);
  }
  return root;
}

/** The two roots of a project that is its own state root. */
function rootsOf(root: string): Roots {
  return { workspace: root, stateRoot: root };
}

describe('assistantMessageOf', () => {
  it('takes a finished assistant message', () => {
    const event = { type: 'message.updated', properties: { info: assistant } };
    expect(assistantMessageOf(event)).toBe(assistant);
  });

  it('leaves a message that is still being written', () => {
    const event = {
      type: 'message.updated',
      properties: { info: { ...assistant, time: { created: 1 } } },
    };
    expect(assistantMessageOf(event)).toBeUndefined();
  });

  it('leaves a message that is not the assistant’s', () => {
    const event = {
      type: 'message.updated',
      properties: { info: { ...assistant, role: 'user' } },
    };
    expect(assistantMessageOf(event)).toBeUndefined();
  });

  it('leaves an event that carries no message', () => {
    expect(assistantMessageOf({ type: 'session.idle', properties: {} })).toBeUndefined();
    expect(assistantMessageOf({ type: 'message.updated', properties: {} })).toBeUndefined();
  });
});

describe('the bridge', () => {
  it('records the message in the ledger under the bean of the lease', async () => {
    const root = await rootWith({ bean: '2b-4', agent: 'oa-builder' });
    await bridgeToLedger(rootsOf(root), {
      raw: assistant,
      sessionID: 'ses-1',
      rootSessionID: 'ses-1',
      agent: 'oa-builder',
    });

    const ledger = openLedger(root);
    try {
      const totals = perTaskTotals(ledger);
      // The bean id is the ledger's task id: that is the join the board's
      // check makes.
      expect(totals).toHaveLength(1);
      expect(totals[0]?.taskId).toBe('2b-4');
      expect(totals[0]?.tokens).toBe(300);
      const row = ledger.query('SELECT role FROM usage WHERE message_id = ?').get('msg-1') as {
        role: string;
      } | null;
      // The role arrives already resolved: the ledger never sees the agent id.
      expect(row?.role).toBe('builder');
    } finally {
      closeLedger(ledger);
    }
  });

  it('records a message of a session that holds no lease, with no task', async () => {
    const root = await rootWith();
    await bridgeToLedger(rootsOf(root), {
      raw: assistant,
      sessionID: 'ses-1',
      rootSessionID: 'ses-1',
      agent: 'oa-builder',
    });

    const ledger = openLedger(root);
    try {
      const row = ledger.query('SELECT task_id FROM usage WHERE message_id = ?').get('msg-1') as {
        task_id: string | null;
      } | null;
      expect(row?.task_id).toBeNull();
    } finally {
      closeLedger(ledger);
    }
  });

  it('never throws into the host, and says why on the record', async () => {
    const root = await rootWith({ bean: '2b-4', agent: 'oa-builder' });
    const broken = { ...assistant, id: undefined };

    await expect(
      bridgeToLedger(rootsOf(root), {
        raw: broken,
        sessionID: 'ses-1',
        rootSessionID: 'ses-1',
        agent: 'oa-builder',
      }),
    ).resolves.toBeUndefined();

    const audit = await readFile(join(root, '.openagentsy', 'audit.jsonl'), 'utf8');
    expect(audit).toContain('oa.ledger.failed');
  });

  it('never throws when the ledger cannot be written', async () => {
    const root = await rootWith({ bean: '2b-4', agent: 'oa-builder' });
    // A file where the ledger's directory should be: the ledger cannot be
    // opened, and the session that is running must not go down for it.
    await rm(join(root, '.openagentsy'), { recursive: true, force: true });
    await mkdir(join(root, '.openagentsy'), { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(root, '.openagentsy', 'ledger.db'), 'not a database', 'utf8');

    await expect(
      bridgeToLedger(rootsOf(root), {
        raw: assistant,
        sessionID: 'ses-1',
        rootSessionID: 'ses-1',
        agent: 'oa-builder',
      }),
    ).resolves.toBeUndefined();
  });
});
