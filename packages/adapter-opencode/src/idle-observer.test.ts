import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type BoardDatabase,
  closeDatabase,
  createRecord,
  migrate,
  openDatabase,
} from '@openagentsy/core';
import {
  closeLedger,
  detectNoProgressAtPath,
  openLedger,
  recordAssistantMessage,
  wasteByKind,
} from '@openagentsy/ledger';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claimedStatusOf,
  observeRoundStatus,
  observeSessionIdle,
  recordNoProgressRounds,
} from './idle-observer.js';

let board: BoardDatabase;
let boardPath: string;
let boardRoot: string;
let ledgerRoot: string;

beforeEach(async () => {
  boardRoot = await mkdtemp(join(tmpdir(), 'openagentsy-board-'));
  boardPath = join(boardRoot, 'board.sqlite');
  board = openDatabase(boardPath);
  migrate(board);
  ledgerRoot = await mkdtemp(join(tmpdir(), 'openagentsy-ledger-'));
});

afterEach(async () => {
  closeDatabase(board);
  await rm(boardRoot, { recursive: true, force: true });
  await rm(ledgerRoot, { recursive: true, force: true });
});

/** One message of the Lead, in the ledger's own ledger. */
function leadMessage(id: string, ts: string, tokens: number): void {
  const db = openLedger(ledgerRoot);
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

describe('the idle observer', () => {
  it('finds nothing when the report and the board agree', () => {
    const finding = observeRoundStatus('awaiting_result', 'awaiting_result', 'ses-1');
    expect(finding).toBeUndefined();
  });

  it('names both statuses when they disagree', () => {
    const finding = observeRoundStatus('complete', 'running', 'ses-1');
    expect(finding?.claimed).toBe('complete');
    expect(finding?.boardStatus).toBe('running');
    expect(finding?.sessionId).toBe('ses-1');
    expect(finding?.detail).toContain('complete');
    expect(finding?.detail).toContain('running');
  });

  it('finds nothing when the board holds no status yet', () => {
    // The Lead has not persisted the round, so there is nothing to
    // contradict the report with.
    expect(observeRoundStatus('complete', undefined, 'ses-1')).toBeUndefined();
  });

  it('finds nothing when the report claims no status', () => {
    expect(observeRoundStatus(undefined, 'running', 'ses-1')).toBeUndefined();
  });

  it('reads the board through the reader it is given', () => {
    const finding = observeSessionIdle('paused', () => 'running', 'ses-1');
    expect(finding?.boardStatus).toBe('running');
    expect(observeSessionIdle('running', () => 'running', 'ses-1')).toBeUndefined();
    expect(observeSessionIdle('paused', () => undefined, 'ses-1')).toBeUndefined();
  });
});

describe('the claimed status', () => {
  it('reads the status a message claims', () => {
    expect(claimedStatusOf('round status: awaiting_result')).toBe('awaiting_result');
    expect(claimedStatusOf('status: complete')).toBe('complete');
    expect(claimedStatusOf('round: paused')).toBe('paused');
  });

  it('reads the status a real Lead report claims', () => {
    expect(claimedStatusOf('The round status is complete, and the board agrees.')).toBe('complete');
    expect(claimedStatusOf('state: awaiting_result')).toBe('awaiting_result');
    expect(claimedStatusOf('the round is paused')).toBe('paused');
    expect(claimedStatusOf('The recovery round is running; next I report.')).toBe('running');
  });

  it('takes the last claim in the message', () => {
    expect(claimedStatusOf('status: running, and now status: complete')).toBe('complete');
  });

  it('finds no claim in a message that makes none', () => {
    expect(claimedStatusOf('the round is done, nothing to report')).toBeUndefined();
    expect(claimedStatusOf('')).toBeUndefined();
  });
});

describe('the round that changed nothing', () => {
  it('writes the no_progress event the ledger writes, and writes it once', () => {
    // The decision is the ledger's, so the observer and `oa ledger` cannot
    // write the same round twice and count its tokens twice.
    createRecord(board, {
      bean: '2c-4',
      kind: 'status',
      from: 'agentsy',
      action: 'the round is over',
      state: 'nothing moved',
      confidence: 'verified',
    });
    leadMessage('l1', '2026-01-01T00:00:00.000Z', 1000);

    const ledger = openLedger(ledgerRoot);
    try {
      expect(detectNoProgressAtPath(ledger, boardPath, { leadAgent: 'agentsy' })).toHaveLength(1);
      expect(recordNoProgressRounds(ledger, boardPath, { leadAgent: 'agentsy' })).toBe(1);
      expect(recordNoProgressRounds(ledger, boardPath, { leadAgent: 'agentsy' })).toBe(0);

      const waste = wasteByKind(ledger).find((row) => row.kind === 'no_progress');
      expect(waste?.count).toBe(1);
      expect(waste?.tokens).toBe(1000);
    } finally {
      closeLedger(ledger);
    }
  });

  it('says nothing about a round that changed something', () => {
    createRecord(board, {
      bean: '2c-4',
      kind: 'status',
      from: 'oa-builder',
      to: 'agentsy',
      action: 'the result is in',
      state: 'commit a1b2c3',
      confidence: 'verified',
    });
    createRecord(board, {
      bean: '2c-4',
      kind: 'status',
      from: 'agentsy',
      action: 'the round is over',
      state: 'the result was consumed',
      confidence: 'verified',
    });
    leadMessage('l1', '2026-01-01T00:00:00.000Z', 1000);

    const ledger = openLedger(ledgerRoot);
    try {
      expect(detectNoProgressAtPath(ledger, boardPath, { leadAgent: 'agentsy' })).toHaveLength(0);
      expect(recordNoProgressRounds(ledger, boardPath, { leadAgent: 'agentsy' })).toBe(0);
      expect(wasteByKind(ledger).some((row) => row.kind === 'no_progress')).toBe(false);
    } finally {
      closeLedger(ledger);
    }
  });
});
