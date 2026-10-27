import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BoardDatabase, createRecord, migrate, openDatabase } from '@openagentsy/core';
import { openLedger, wasteByKind } from '@openagentsy/ledger';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claimedStatusOf,
  observeRoundStatus,
  observeSessionIdle,
  readRoundFacts,
  recordNoProgressRound,
  roundChangedNothing,
} from './idle-observer.js';

let board: BoardDatabase;
let ledgerRoot: string;

beforeEach(async () => {
  board = openDatabase(':memory:');
  migrate(board);
  ledgerRoot = await mkdtemp(join(tmpdir(), 'openagentsy-ledger-'));
});

afterEach(async () => {
  await rm(ledgerRoot, { recursive: true, force: true });
});

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

  it('takes the last claim in the message', () => {
    expect(claimedStatusOf('status: running, and now status: complete')).toBe('complete');
  });

  it('finds no claim in a message that makes none', () => {
    expect(claimedStatusOf('the round is done, nothing to report')).toBeUndefined();
    expect(claimedStatusOf('')).toBeUndefined();
  });
});

describe('the round facts', () => {
  it('counts a round that dispatched nothing and changed nothing', () => {
    const facts = readRoundFacts(board, {
      agent: 'agentsy',
      from: '2026-01-01T00:00:00.000Z',
      until: '2026-01-02T00:00:00.000Z',
    });
    expect(facts).toEqual({ dispatched: 0, consumed: 0, changed: false });
  });

  it('counts a dispatch the round made', () => {
    createRecord(board, {
      bean: '2c-4',
      kind: 'contract',
      from: 'agentsy',
      to: 'oa-builder',
      action: 'dispatched the recovery loop',
      state: 'owner: oa-builder',
      confidence: 'verified',
    });
    const facts = readRoundFacts(board, {
      agent: 'agentsy',
      from: '2020-01-01T00:00:00.000Z',
      until: '2999-01-01T00:00:00.000Z',
    });
    expect(facts.dispatched).toBe(1);
    expect(facts.changed).toBe(false);
  });

  it('counts a result the round consumed', () => {
    createRecord(board, {
      bean: '2c-4',
      kind: 'status',
      from: 'oa-builder',
      to: 'agentsy',
      action: 'the recovery loop landed',
      state: 'commit a1b2c3',
      confidence: 'verified',
    });
    const facts = readRoundFacts(board, {
      agent: 'agentsy',
      from: '2020-01-01T00:00:00.000Z',
      until: '2999-01-01T00:00:00.000Z',
    });
    expect(facts.consumed).toBe(1);
  });
});

describe('the round that changed nothing', () => {
  it('is a round with no dispatch, no result and no board change', () => {
    expect(roundChangedNothing({ dispatched: 0, consumed: 0, changed: false })).toBe(true);
    expect(roundChangedNothing({ dispatched: 1, consumed: 0, changed: false })).toBe(false);
    expect(roundChangedNothing({ dispatched: 0, consumed: 1, changed: false })).toBe(false);
    expect(roundChangedNothing({ dispatched: 0, consumed: 0, changed: true })).toBe(false);
  });

  it('writes a no_progress waste event', () => {
    const ledger = openLedger(ledgerRoot);
    try {
      const written = recordNoProgressRound(
        ledger,
        { dispatched: 0, consumed: 0, changed: false },
        { tokens: 1200, ts: '2026-01-01T00:00:00.000Z', messageId: 'msg-1' },
      );
      expect(written).toBe(true);
      const waste = wasteByKind(ledger).find((row) => row.kind === 'no_progress');
      expect(waste?.count).toBe(1);
      expect(waste?.tokens).toBe(1200);
    } finally {
      ledger.close();
    }
  });

  it('writes nothing when the round changed something', () => {
    const ledger = openLedger(ledgerRoot);
    try {
      const written = recordNoProgressRound(
        ledger,
        { dispatched: 1, consumed: 0, changed: false },
        { tokens: 1200, ts: '2026-01-01T00:00:00.000Z' },
      );
      expect(written).toBe(false);
      expect(wasteByKind(ledger).some((row) => row.kind === 'no_progress')).toBe(false);
    } finally {
      ledger.close();
    }
  });
});
