import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeLedger, openLedger, recordAssistantMessage } from '@openagentsy/ledger';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatLedgerReport, runLedger } from './ledger.js';

let root: string;

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
