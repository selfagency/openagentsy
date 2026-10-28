import { Database } from 'bun:sqlite';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeLedger, openLedger } from './db.js';
import {
  backfillFromOpencode,
  normalizeOcMessage,
  recordAssistantMessage,
  recordWaste,
} from './ingest.js';
import { perRoleTotals } from './query.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openagentsy-ingest-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const CTX = {
  rootSessionId: 'ses_root',
  role: 'builder',
  latencyMs: 1200,
  activeTaskId: 'oa-2b-1',
  ts: '2026-10-26T10:00:00.000Z',
};

const MESSAGE = {
  id: 'msg_1',
  sessionID: 'ses_child',
  providerID: 'anthropic',
  modelID: 'claude-sonnet-4-5',
  tokens: { input: 100, output: 40, reasoning: 10, cache: { read: 900, write: 5 } },
  cost: 0.25,
};

describe('the normalizer', () => {
  it('reads the flat shape of V1', () => {
    const message = normalizeOcMessage(MESSAGE);
    expect(message.id).toBe('msg_1');
    expect(message.providerID).toBe('anthropic');
    expect(message.modelID).toBe('claude-sonnet-4-5');
    expect(message.tokens?.cache?.read).toBe(900);
  });

  it('reads the nested shape of V2', () => {
    const message = normalizeOcMessage({
      id: 'msg_2',
      sessionID: 'ses_child',
      model: { providerID: 'anthropic', id: 'claude-sonnet-4-5' },
      tokens: { input: 100, output: 40, reasoning: 10, cache: { read: 900, write: 5 } },
      cost: 0.25,
    });
    expect(message.id).toBe('msg_2');
    expect(message.providerID).toBe('anthropic');
    expect(message.modelID).toBe('claude-sonnet-4-5');
    expect(message.tokens?.input).toBe(100);
  });

  it('reads a message nested under a message', () => {
    const message = normalizeOcMessage({
      message: {
        id: 'msg_3',
        sessionID: 'ses_child',
        model: { providerID: 'ollama-cloud', id: 'beam' },
        tokens: { input: 1, output: 2 },
      },
    });
    expect(message.id).toBe('msg_3');
    expect(message.providerID).toBe('ollama-cloud');
    expect(message.modelID).toBe('beam');
  });

  it('refuses a message without an id', () => {
    expect(() => normalizeOcMessage({ providerID: 'anthropic' })).toThrow(/no id/);
  });
});

describe('the ingest', () => {
  it('writes one row per message', () => {
    const db = openLedger(root);
    try {
      recordAssistantMessage(db, MESSAGE, CTX);
      recordAssistantMessage(db, MESSAGE, CTX);
      const rows = db.query('SELECT COUNT(*) AS count FROM usage').get() as { count: number };
      expect(rows.count).toBe(1);
    } finally {
      closeLedger(db);
    }
  });

  it('stores the role it is given, without resolving it', () => {
    const db = openLedger(root);
    try {
      recordAssistantMessage(db, MESSAGE, { ...CTX, role: 'agentsy' });
      const row = db.query('SELECT role, role_raw FROM usage').get() as {
        role: string | null;
        role_raw: string | null;
      };
      expect(row.role).toBe('agentsy');
      expect(row.role_raw).toBe(null);
    } finally {
      closeLedger(db);
    }
  });

  it('counts the reasoning once for a provider that folds it into the output', () => {
    const db = openLedger(root);
    try {
      recordAssistantMessage(db, { ...MESSAGE, id: 'msg_codex', providerID: 'codex' }, CTX);
      const row = db
        .query('SELECT output, reasoning FROM usage WHERE message_id = ?')
        .get('msg_codex') as {
        output: number;
        reasoning: number;
      };
      expect(row.output).toBe(30);
      expect(row.reasoning).toBe(10);
    } finally {
      closeLedger(db);
    }
  });

  it('leaves the cost empty when the host reported none', () => {
    const db = openLedger(root);
    try {
      const { cost: _cost, ...withoutCost } = MESSAGE;
      recordAssistantMessage(db, withoutCost, CTX);
      const row = db.query('SELECT cost_reported, cost_estimated FROM usage').get() as {
        cost_reported: number | null;
        cost_estimated: number | null;
      };
      expect(row.cost_reported).toBe(null);
      expect(row.cost_estimated).toBe(null);
    } finally {
      closeLedger(db);
    }
  });

  it('redacts a secret in a waste detail', () => {
    const db = openLedger(root);
    try {
      const secret = ['sk', 'abcdefghijklmnopqrstuvwx'].join('-');
      recordWaste(db, {
        rootSessionId: 'ses_root',
        kind: 'retry',
        tokens: 10,
        detail: `the key was ${secret}`,
        ts: CTX.ts,
      });
      const row = db.query('SELECT detail FROM waste').get() as { detail: string };
      expect(row.detail).not.toContain(secret);
      expect(row.detail).toContain('redacted');
    } finally {
      closeLedger(db);
    }
  });
});

describe('the backfill', () => {
  async function fixture(dataDir: string): Promise<void> {
    await mkdir(dataDir, { recursive: true });
    const source = new Database(join(dataDir, 'opencode.db'), { create: true });
    source.exec(
      'CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, data text NOT NULL)',
    );
    source.exec('CREATE TABLE session (id text PRIMARY KEY, parent_id text)');
    source.query('INSERT INTO session (id, parent_id) VALUES (?, ?)').run('ses_root', null);
    source.query('INSERT INTO session (id, parent_id) VALUES (?, ?)').run('ses_child', 'ses_root');
    source.query('INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)').run(
      'msg_old',
      'ses_child',
      1_700_000_000_000,
      JSON.stringify({
        role: 'assistant',
        agent: 'oa-builder',
        providerID: 'anthropic',
        modelID: 'claude-sonnet-4-5',
        tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 5, write: 1 } },
        cost: 0.5,
      }),
    );
    // A provider of the Codex family folds the reasoning into the output.
    source.query('INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)').run(
      'msg_codex',
      'ses_child',
      1_600_000_000_000,
      JSON.stringify({
        role: 'assistant',
        agent: 'oa-builder',
        providerID: 'codex',
        modelID: 'gpt-codex',
        tokens: { input: 5, output: 40, reasoning: 10, cache: { read: 0, write: 0 } },
      }),
    );
    source.close();
  }

  it('is off unless it is asked for', async () => {
    const dataDir = join(root, 'opencode');
    await fixture(dataDir);
    const db = openLedger(root);
    try {
      const result = backfillFromOpencode(db, { dataDir });
      expect(result.enabled).toBe(false);
      expect(result.imported).toBe(0);
      const rows = db.query('SELECT COUNT(*) AS count FROM usage').get() as { count: number };
      expect(rows.count).toBe(0);
    } finally {
      closeLedger(db);
    }
  });

  it('imports the past messages with the role unresolved', async () => {
    const dataDir = join(root, 'opencode');
    await fixture(dataDir);
    const db = openLedger(root);
    try {
      const result = backfillFromOpencode(db, { enabled: true, dataDir });
      expect(result.errors).toEqual([]);
      expect(result.imported).toBe(2);

      const row = db.query('SELECT role, role_raw, root_session_id, input FROM usage').get() as {
        role: string | null;
        role_raw: string | null;
        root_session_id: string;
        input: number;
      };
      expect(row.role).toBe(null);
      expect(row.role_raw).toBe('oa-builder');
      expect(row.root_session_id).toBe('ses_root');
      expect(row.input).toBe(10);
    } finally {
      closeLedger(db);
    }
  });

  it('counts the reasoning once for a backfilled codex message', async () => {
    const dataDir = join(root, 'opencode');
    await fixture(dataDir);
    const db = openLedger(root);
    try {
      backfillFromOpencode(db, { enabled: true, dataDir });
      const row = db
        .query('SELECT output, reasoning FROM usage WHERE message_id = ?')
        .get('msg_codex') as { output: number; reasoning: number };
      expect(row.reasoning).toBe(10);
      expect(row.output).toBe(30);
    } finally {
      closeLedger(db);
    }
  });

  it('leaves an imported row out of the per-role report', async () => {
    const dataDir = join(root, 'opencode');
    await fixture(dataDir);
    const db = openLedger(root);
    try {
      backfillFromOpencode(db, { enabled: true, dataDir });
      expect(perRoleTotals(db)).toEqual([]);
    } finally {
      closeLedger(db);
    }
  });

  it('refuses a file whose tables differ, and says what it found', async () => {
    const dataDir = join(root, 'opencode');
    await mkdir(dataDir, { recursive: true });
    const source = new Database(join(dataDir, 'opencode.db'), { create: true });
    source.exec('CREATE TABLE blobs (id text PRIMARY KEY, value text)');
    source.close();

    const db = openLedger(root);
    try {
      const result = backfillFromOpencode(db, { enabled: true, dataDir });
      expect(result.imported).toBe(0);
      expect(result.errors[0]).toMatch(/no "message" table/);
    } finally {
      closeLedger(db);
    }
  });
});
