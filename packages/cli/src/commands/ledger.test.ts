import { mkdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeDatabase,
  createRecord,
  migrate,
  openDatabase,
  type ProjectRoots,
} from '@openagentsy/core';
import { closeLedger, openLedger, recordAssistantMessage, runGit } from '@openagentsy/ledger';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatLedgerReport,
  formatOutcomesReport,
  formatScanRevertsReport,
  formatWasteReport,
  runLedger,
  runLedgerOutcomes,
  runLedgerScanReverts,
  runLedgerWaste,
} from './ledger.js';

let root: string;

/** The two roots of a project that is its own state root. */
function rootsOf(root: string): ProjectRoots {
  return { workspace: root, stateRoot: root };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openagentsy-ledger-cli-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const CTX = {
  rootSessionId: 'ses_1',
  role: 'builder',
  ts: '2026-10-26T10:00:00.000Z',
};

function seed(): void {
  const db = openLedger(root);
  try {
    recordAssistantMessage(
      db,
      {
        id: 'msg_1',
        sessionID: 'ses_1',
        providerID: 'anthropic',
        modelID: 'claude-sonnet-4-5',
        tokens: { input: 100, output: 40, reasoning: 10, cache: { read: 900, write: 5 } },
        cost: 0.5,
      },
      CTX,
    );
  } finally {
    closeLedger(db);
  }
}

describe('the ledger command', () => {
  it('shows nothing for a project without a ledger, and creates no file', async () => {
    const report = await runLedger(root);
    expect(report.exists).toBe(false);
    expect(report.counters.totals.messages).toBe(0);
    expect(formatLedgerReport(report)).toContain('missing');
  });

  it('shows the counters of a ledger', async () => {
    seed();
    const report = await runLedger(root);
    expect(report.exists).toBe(true);
    expect(report.counters.totals.messages).toBe(1);
    expect(report.counters.totals.tokens).toBe(155);
    expect(report.counters.totals.usd).toBe(0.5);
    const text = formatLedgerReport(report);
    expect(text).toContain('builder');
    expect(text).toContain('$0.5000');
  });

  it('shows an unpriced message as unpriced, not as zero', async () => {
    seed();
    const db = openLedger(root);
    try {
      recordAssistantMessage(
        db,
        {
          id: 'msg_2',
          sessionID: 'ses_1',
          providerID: 'anthropic',
          modelID: 'claude-sonnet-4-5',
          tokens: { input: 10, output: 5 },
        },
        { ...CTX, role: 'lead' },
      );
    } finally {
      closeLedger(db);
    }
    const report = await runLedger(root);
    expect(report.counters.totals.unpricedMessages).toBe(1);
    expect(formatLedgerReport(report)).toContain('unpriced');
  });

  it('exports the counters and nothing else', async () => {
    seed();
    const report = await runLedger(root);
    expect(report.counters.schema).toBe('openagentsy.ledger/v1');
    const json = JSON.stringify(report.counters);
    expect(json).not.toContain('msg_1');
    expect(json).not.toContain('ses_1');
    expect(json).not.toContain('claude-sonnet-4-5');
  });
});

/** A board of the shape the board writes, for the no-progress detector. */
function seedBoard(): void {
  const dir = join(root, '.openagentsy');
  mkdirSync(dir, { recursive: true });
  const db = openDatabase(join(dir, 'board.sqlite'));
  try {
    migrate(db);
    createRecord(db, {
      bean: 'bean',
      kind: 'status',
      from: 'agentsy',
      action: 'the Lead wrote down where it was',
      state: 'nothing came of the round',
      confidence: 'verified',
    });
  } finally {
    closeDatabase(db);
  }
}

/** A Lead message in the ledger. */
function seedLead(): void {
  const db = openLedger(root);
  try {
    recordAssistantMessage(
      db,
      {
        id: 'l1',
        sessionID: 'ses_lead',
        providerID: 'anthropic',
        modelID: 'claude-sonnet-4-5',
        tokens: { input: 1000, output: 0 },
      },
      { rootSessionId: 'ses_lead', role: 'lead', ts: '2026-01-01T00:00:00.000Z' },
    );
  } finally {
    closeLedger(db);
  }
}

/** A builder message of a task, for the token share of a revert. */
function seedBuilder(target: string, taskId: string): void {
  const db = openLedger(target);
  try {
    recordAssistantMessage(
      db,
      {
        id: 'b1',
        sessionID: 'ses_builder',
        providerID: 'anthropic',
        modelID: 'claude-sonnet-4-5',
        tokens: { input: 2000, output: 0 },
      },
      {
        rootSessionId: 'ses_builder',
        role: 'builder',
        activeTaskId: taskId,
        ts: '2026-01-01T00:00:00.000Z',
      },
    );
  } finally {
    closeLedger(db);
  }
}

/** A repository with a commit that was taken back and one that was not. */
async function seedRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'openagentsy-cli-repo-'));
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

  await writeFile(join(repo, 'f.txt'), 'alpha\nbeta\n');
  git('add', 'f.txt');
  git('commit', '-q', '-m', 'feat: add the file\n\nRefs: task-1');

  await writeFile(join(repo, 'f.txt'), 'gamma\n');
  git('add', 'f.txt');
  git('commit', '-q', '-m', 'chore: rewrite the file');
  return repo;
}

describe('the waste command', () => {
  it('finds the round of the Lead that went nowhere and says what the waste is', async () => {
    seedBoard();
    seedLead();
    const empty = await mkdtemp(join(tmpdir(), 'openagentsy-cli-empty-'));

    const report = await runLedgerWaste(root, { dataDir: empty, leadAgent: 'agentsy' });

    expect(report.written).toBe(1);
    expect(report.byKind.find((kind) => kind.kind === 'no_progress')?.tokens).toBe(1000);
    expect(report.totals.tokens).toBe(1000);
    const text = formatWasteReport(report);
    expect(text).toContain('no_progress');
    expect(text).toContain('100.0%');
  });

  it('says nothing when there is no board to read', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'openagentsy-cli-empty-'));
    const report = await runLedgerWaste(root, { dataDir: empty });
    expect(report.written).toBe(0);
    expect(report.byKind).toHaveLength(0);
  });
});

describe('the scan-reverts command', () => {
  it('finds the code that was taken back and writes it down', async () => {
    const repo = await seedRepo();
    seedBuilder(repo, 'task-1');

    const report = await runLedgerScanReverts(rootsOf(repo), { since: '30 days ago' });

    expect(report.found).toBe(1);
    expect(report.written).toBe(1);
    expect(report.tokens).toBe(2000);
    expect(formatScanRevertsReport(report)).toContain('scan-reverts');

    const db = openLedger(repo);
    try {
      const row = db.query('SELECT kind, tokens FROM waste').get() as {
        kind: string;
        tokens: number;
      };
      expect(row.kind).toBe('reverted_code');
      expect(row.tokens).toBe(2000);
    } finally {
      closeLedger(db);
    }
  });
});

describe('the outcomes command', () => {
  it('finds the commits that name a task and writes them down', async () => {
    const repo = await seedRepo();

    const report = await runLedgerOutcomes(rootsOf(repo), { since: '30 days ago' });

    expect(report.found).toBe(1);
    expect(report.written).toBe(1);
    expect(report.byKind.find((kind) => kind.kind === 'commit')?.count).toBe(1);
    expect(formatOutcomesReport(report)).toContain('commit');

    const db = openLedger(repo);
    try {
      const row = db.query('SELECT kind, task_id FROM outcome').get() as {
        kind: string;
        task_id: string;
      };
      expect(row.kind).toBe('commit');
      expect(row.task_id).toBe('task-1');
    } finally {
      closeLedger(db);
    }
  });

  it('writes the outcome once, however often it runs', async () => {
    const repo = await seedRepo();
    await runLedgerOutcomes(rootsOf(repo), { since: '30 days ago' });
    const report = await runLedgerOutcomes(rootsOf(repo), { since: '30 days ago' });
    expect(report.written).toBe(0);
  });
});
