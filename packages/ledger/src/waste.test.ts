import { Database } from 'bun:sqlite';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeLedger, openLedger } from './db.js';
import { runGit } from './git.js';
import { recordAssistantMessage } from './ingest.js';
import {
  detectCacheMiss,
  detectNoProgress,
  detectNoProgressAtPath,
  recordWasteRows,
  scanReverts,
} from './waste.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openagentsy-waste-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A message of the fixture storage. */
type StoredMessage = {
  id: string;
  role: 'assistant' | 'user';
  at: number;
  tokens?: { input: number; output: number; cache: { read: number; write: number } } | undefined;
};

/** A part of a fixture message. */
type StoredPart = { messageId: string; type: string; text?: string | undefined };

/**
 * A storage file of the shape the OpenCode version of this project writes.
 *
 * The table and the JSON are the ones the backfill reads, so the detector is
 * proven against the same shape it meets in the wild. The parts table is
 * written only when the fixture needs it: a storage without parts is a
 * storage that cannot say what a user turn carried.
 */
async function seedStorage(messages: StoredMessage[], parts: StoredPart[] = []): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'openagentsy-storage-'));
  const db = new Database(join(dir, 'opencode.db'), { create: true });
  db.exec(
    'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)',
  );
  const insert = db.query(
    'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)',
  );
  for (const message of messages) {
    const data: Record<string, unknown> = { role: message.role, time: { created: message.at } };
    if (message.tokens !== undefined) {
      data.tokens = message.tokens;
      data.modelID = 'claude-sonnet-4-5';
      data.providerID = 'anthropic';
    }
    insert.run(message.id, 'ses_1', message.at, message.at, JSON.stringify(data));
  }
  if (parts.length > 0) {
    db.exec(
      'CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)',
    );
    const insertPart = db.query(
      'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)',
    );
    for (const part of parts) {
      insertPart.run(
        `part_${part.messageId}`,
        part.messageId,
        'ses_1',
        0,
        0,
        JSON.stringify({ type: part.type, text: part.text ?? '' }),
      );
    }
  }
  db.close();
  return dir;
}

/** A board database of the shape the board writes. */
async function seedBoard(
  records: { id: number; from: string; to: string | null; at: string }[],
  reads: { id: number; agent: string; at: string }[] = [],
): Promise<string> {
  const path = join(root, 'board.sqlite');
  const db = new Database(path, { create: true });
  db.exec(`
    CREATE TABLE records (
      id INTEGER PRIMARY KEY, bean TEXT, kind TEXT, from_agent TEXT, to_agent TEXT,
      action TEXT, state TEXT, confidence TEXT, created_at TEXT);
    CREATE TABLE record_reads (record_id INTEGER, agent TEXT, read_at TEXT);
    CREATE TABLE leases (id INTEGER PRIMARY KEY, bean TEXT, agent TEXT, glob TEXT, granted_at TEXT);
  `);
  const insert = db.query(
    'INSERT INTO records (id, bean, kind, from_agent, to_agent, action, state, confidence, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
  );
  for (const record of records) {
    insert.run(
      record.id,
      'bean',
      'status',
      record.from,
      record.to,
      'action',
      'state',
      'verified',
      record.at,
    );
  }
  const read = db.query('INSERT INTO record_reads (record_id, agent, read_at) VALUES (?,?,?)');
  for (const entry of reads) read.run(entry.id, entry.agent, entry.at);
  db.close();
  return path;
}

/** A Lead message in the ledger. */
function leadMessage(id: string, ts: string, tokens: number): void {
  const db = openLedger(root);
  try {
    recordAssistantMessage(
      db,
      {
        id,
        sessionID: 'ses_lead',
        providerID: 'anthropic',
        modelID: 'claude-sonnet-4-5',
        tokens: { input: tokens, output: 0 },
      },
      { rootSessionId: 'ses_lead', role: 'lead', ts },
    );
  } finally {
    closeLedger(db);
  }
}

const LOW_RATIO = { input: 2000, output: 100, cache: { read: 100, write: 0 } };
const HIGH_RATIO = { input: 100, output: 100, cache: { read: 9000, write: 0 } };

describe('the cache-miss detector', () => {
  it('finds the turn that had no new user turn and read the prefix again', async () => {
    const storage = await seedStorage([
      { id: 'm1', role: 'assistant', at: 1000, tokens: LOW_RATIO },
      { id: 'm2', role: 'assistant', at: 2000, tokens: LOW_RATIO },
      { id: 'm3', role: 'assistant', at: 3000, tokens: HIGH_RATIO },
      { id: 'u1', role: 'user', at: 4000 },
      { id: 'm4', role: 'assistant', at: 5000, tokens: LOW_RATIO },
    ]);
    const db = openLedger(root);
    try {
      recordAssistantMessage(
        db,
        {
          id: 'm1',
          sessionID: 'ses_1',
          providerID: 'anthropic',
          modelID: 'claude-sonnet-4-5',
          tokens: { input: 2000, output: 100 },
        },
        { rootSessionId: 'ses_root', role: 'builder', ts: '2026-01-01T00:00:00.000Z' },
      );

      const candidates = detectCacheMiss(db, { dataDir: storage });

      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.kind).toBe('cache_miss');
      expect(candidates[0]?.messageId).toBe('m2');
      // The uncached input of the turn.
      expect(candidates[0]?.tokens).toBe(2000);
      expect(candidates[0]?.rootSessionId).toBe('ses_root');
    } finally {
      closeLedger(db);
    }
  });

  it('says nothing when the prefix was read from the cache', async () => {
    const storage = await seedStorage([
      { id: 'm1', role: 'assistant', at: 1000, tokens: HIGH_RATIO },
      { id: 'm2', role: 'assistant', at: 2000, tokens: HIGH_RATIO },
    ]);
    const db = openLedger(root);
    try {
      const candidates = detectCacheMiss(db, { dataDir: storage, sessions: ['ses_1'] });
      expect(candidates).toHaveLength(0);
    } finally {
      closeLedger(db);
    }
  });

  it('says nothing when a user turn came in between', async () => {
    const storage = await seedStorage([
      { id: 'm1', role: 'assistant', at: 1000, tokens: LOW_RATIO },
      { id: 'u1', role: 'user', at: 2000 },
      { id: 'm2', role: 'assistant', at: 3000, tokens: LOW_RATIO },
    ]);
    const db = openLedger(root);
    try {
      const candidates = detectCacheMiss(db, { dataDir: storage, sessions: ['ses_1'] });
      expect(candidates).toHaveLength(0);
    } finally {
      closeLedger(db);
    }
  });

  it('keeps the pair when the user turn carried nothing the user wrote', async () => {
    const storage = await seedStorage(
      [
        { id: 'm1', role: 'assistant', at: 1000, tokens: LOW_RATIO },
        { id: 'u1', role: 'user', at: 2000 },
        { id: 'm2', role: 'assistant', at: 3000, tokens: LOW_RATIO },
      ],
      [{ messageId: 'u1', type: 'file' }],
    );
    const db = openLedger(root);
    try {
      const candidates = detectCacheMiss(db, { dataDir: storage, sessions: ['ses_1'] });
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.messageId).toBe('m2');
    } finally {
      closeLedger(db);
    }
  });

  it('writes every signal once, however often the detector runs', async () => {
    const storage = await seedStorage([
      { id: 'm1', role: 'assistant', at: 1000, tokens: LOW_RATIO },
      { id: 'm2', role: 'assistant', at: 2000, tokens: LOW_RATIO },
    ]);
    const db = openLedger(root);
    try {
      const candidates = detectCacheMiss(db, { dataDir: storage, sessions: ['ses_1'] });
      expect(recordWasteRows(db, candidates)).toBe(1);
      expect(recordWasteRows(db, candidates)).toBe(0);
      const rows = db.query('SELECT COUNT(*) AS count FROM waste').get() as { count: number };
      expect(rows.count).toBe(1);
    } finally {
      closeLedger(db);
    }
  });
});

describe('the no-progress detector', () => {
  it('finds the round that dispatched nothing and changed nothing', async () => {
    await seedBoard([
      { id: 1, from: 'agentsy', to: null, at: '2026-01-01T00:01:00.000Z' },
      { id: 2, from: 'agentsy', to: 'oa-builder', at: '2026-01-01T00:03:00.000Z' },
      { id: 3, from: 'oa-builder', to: null, at: '2026-01-01T00:04:30.000Z' },
      { id: 4, from: 'agentsy', to: null, at: '2026-01-01T00:05:00.000Z' },
    ]);
    leadMessage('l1', '2026-01-01T00:00:00.000Z', 1000);
    leadMessage('l2', '2026-01-01T00:02:00.000Z', 500);
    leadMessage('l3', '2026-01-01T00:04:00.000Z', 700);

    const boardDb = new Database(join(root, 'board.sqlite'), { readonly: true });
    const db = openLedger(root);
    try {
      const candidates = detectNoProgress(db, boardDb, { leadAgent: 'agentsy' });
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.kind).toBe('no_progress');
      expect(candidates[0]?.tokens).toBe(1000);
    } finally {
      closeLedger(db);
      boardDb.close();
    }
  });

  it('says nothing about a round that consumed a result', async () => {
    await seedBoard(
      [{ id: 1, from: 'agentsy', to: null, at: '2026-01-01T00:01:00.000Z' }],
      [{ id: 1, agent: 'agentsy', at: '2026-01-01T00:00:30.000Z' }],
    );
    leadMessage('l1', '2026-01-01T00:00:00.000Z', 1000);

    const candidates = detectNoProgressAtPath(openLedger(root), join(root, 'board.sqlite'), {
      leadAgent: 'agentsy',
    });
    expect(candidates).toHaveLength(0);
  });

  it('leaves the rounds that closed before the window alone', async () => {
    await seedBoard([{ id: 1, from: 'agentsy', to: null, at: '2026-01-01T00:01:00.000Z' }]);
    leadMessage('l1', '2026-01-01T00:00:00.000Z', 1000);

    const db = openLedger(root);
    try {
      const candidates = detectNoProgressAtPath(db, join(root, 'board.sqlite'), {
        leadAgent: 'agentsy',
        since: '2026-01-01T00:02:00.000Z',
      });
      expect(candidates).toHaveLength(0);
    } finally {
      closeLedger(db);
    }
  });
});

describe('the revert scanner', () => {
  it('finds the commit whose lines were taken back', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'openagentsy-repo-'));
    await seedRepo(repo);

    const candidates = scanReverts(repo, '30 days ago', { tokensForTask: () => 2000 });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.kind).toBe('reverted_code');
    expect(candidates[0]?.tokens).toBe(2000);
    expect(candidates[0]?.detail).toContain('task-1');
  });

  it('says nothing about a commit whose lines survived', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'openagentsy-repo-'));
    await seedRepo(repo);

    const candidates = scanReverts(repo, '30 days ago', {
      tokensForTask: (taskId) => (taskId === 'task-2' ? 2000 : 0),
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.detail).toContain('task-1');
  });
});

/** A repository with one commit that was taken back and one that was not. */
async function seedRepo(repo: string): Promise<void> {
  const git = (...args: string[]): void => {
    const result = runGit(repo, [
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=Test',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ]);
    if (!result.ok) throw new Error(result.stderr);
  };
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');

  await writeFile(join(repo, 'f.txt'), 'alpha\nbeta\ngamma\n');
  git('add', 'f.txt');
  git('commit', '-q', '-m', 'feat: add the file\n\nRefs: task-1');

  await writeFile(join(repo, 'f.txt'), 'delta\n');
  git('add', 'f.txt');
  git('commit', '-q', '-m', 'chore: rewrite the file');

  await writeFile(join(repo, 'g.txt'), 'keep\n');
  git('add', 'g.txt');
  git('commit', '-q', '-m', 'feat: add the other file\n\nRefs: task-2');
}
