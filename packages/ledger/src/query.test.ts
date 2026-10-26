import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { estimateRemote, r } from '@openagentsy/footprint';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeLedger, openLedger } from './db.js';
import { ledgerExport } from './export.js';
import { FOOTPRINT_METHOD_VERSION, recordFootprint } from './footprint.js';
import { recordAssistantMessage, recordWaste } from './ingest.js';
import {
  ledgerTotals,
  perRoleTotals,
  perTaskTotals,
  tokensPerCompletedTask,
  wasteTotals,
} from './query.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openagentsy-query-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const CTX = {
  rootSessionId: 'ses_root',
  role: 'builder',
  ts: '2026-10-26T10:00:00.000Z',
};

const BUILDER = {
  id: 'msg_builder',
  sessionID: 'ses_child',
  providerID: 'anthropic',
  modelID: 'claude-sonnet-4-5',
  tokens: { input: 100, output: 40, reasoning: 10, cache: { read: 900, write: 5 } },
  cost: 0.5,
};

const LEAD = {
  id: 'msg_lead',
  sessionID: 'ses_root',
  providerID: 'anthropic',
  modelID: 'claude-sonnet-4-5',
  tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
};

const OFFLOAD = {
  id: 'msg_offload',
  sessionID: 'ses_root',
  providerID: 'ollama-local',
  modelID: 'qwen3',
  tokens: { input: 20, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
};

function seed(): void {
  const db = openLedger(root);
  try {
    recordAssistantMessage(db, BUILDER, { ...CTX, role: 'builder', activeTaskId: 'oa-2b-1' });
    recordAssistantMessage(db, LEAD, { ...CTX, role: 'lead', activeTaskId: 'oa-2b-1' });
    recordAssistantMessage(db, OFFLOAD, { ...CTX, role: 'offload' });
    recordWaste(db, {
      rootSessionId: 'ses_root',
      kind: 'retry',
      tokens: 20,
      detail: 'the same tool twice',
      ts: CTX.ts,
    });
    db.query(
      `INSERT INTO outcome (root_session_id, task_id, commit_sha, kind, ts)
         VALUES ('ses_root', 'oa-2b-1', 'abc1234', 'task_completed', '2026-10-26T11:00:00.000Z')`,
    ).run();
  } finally {
    closeLedger(db);
  }
}

describe('the queries', () => {
  it('totals the tokens per resolved role', () => {
    seed();
    const db = openLedger(root);
    try {
      const roles = perRoleTotals(db);
      expect(roles.map((row) => row.role)).toEqual(['builder', 'offload', 'lead']);
      const builder = roles[0];
      expect(builder?.messages).toBe(1);
      expect(builder?.tokens).toBe(155);
      expect(builder?.usd).toBe(0.5);
      expect(builder?.unpriced).toBe(0);
      const lead = roles[1];
      expect(lead?.usd).toBe(null);
      expect(lead?.unpriced).toBe(1);
    } finally {
      closeLedger(db);
    }
  });

  it('totals the tokens per task', () => {
    seed();
    const db = openLedger(root);
    try {
      const tasks = perTaskTotals(db);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.taskId).toBe('oa-2b-1');
      expect(tasks[0]?.messages).toBe(2);
      expect(tasks[0]?.tokens).toBe(170);
      expect(tasks[0]?.usd).toBe(0.5);
    } finally {
      closeLedger(db);
    }
  });

  it('joins the outcomes to the tokens of the task', () => {
    seed();
    const db = openLedger(root);
    try {
      const completed = tokensPerCompletedTask(db);
      expect(completed).toHaveLength(1);
      expect(completed[0]?.taskId).toBe('oa-2b-1');
      expect(completed[0]?.tokens).toBe(170);
      expect(completed[0]?.usd).toBe(0.5);
    } finally {
      closeLedger(db);
    }
  });

  it('shares the waste of the total', () => {
    seed();
    const db = openLedger(root);
    try {
      const waste = wasteTotals(db);
      expect(waste.tokens).toBe(20);
      expect(waste.percentage).toBeCloseTo(10, 5);
    } finally {
      closeLedger(db);
    }
  });

  it('totals every message', () => {
    seed();
    const db = openLedger(root);
    try {
      const totals = ledgerTotals(db);
      expect(totals.messages).toBe(3);
      expect(totals.tokens).toBe(200);
      expect(totals.unpricedMessages).toBe(2);
    } finally {
      closeLedger(db);
    }
  });
});

describe('the export', () => {
  it('carries the counters and nothing else', () => {
    seed();
    const db = openLedger(root);
    try {
      const exported = ledgerExport(db, { generatedAt: '2026-10-26T12:00:00.000Z' });
      expect(exported.schema).toBe('openagentsy.ledger/v1');
      expect(exported.totals.messages).toBe(3);
      expect(exported.totals.tokens).toBe(200);
      expect(exported.byRole).toHaveLength(3);
      expect(exported.byTask[0]?.taskId).toBe('oa-2b-1');
      expect(exported.waste.percentage).toBeCloseTo(10, 5);
      expect(exported.outcomes.tasksCompleted).toBe(1);
      expect(exported.offload.messages).toBe(1);
      expect(exported.offload.tokens).toBe(30);
    } finally {
      closeLedger(db);
    }
  });

  it('carries no prompt, no code and no identifier', () => {
    seed();
    const db = openLedger(root);
    try {
      const exported = ledgerExport(db);
      const forbidden = [
        'prompt',
        'prompts',
        'text',
        'content',
        'code',
        'detail',
        'body',
        'parts',
        'completion',
        'transcript',
        'diff',
        'message_id',
        'messageId',
        'session_id',
        'sessionID',
        'commit_sha',
        'commitSha',
      ];
      const keys = new Set<string>();
      const walk = (value: unknown): void => {
        if (Array.isArray(value)) {
          for (const item of value) walk(item);
          return;
        }
        if (typeof value === 'object' && value !== null) {
          for (const [key, child] of Object.entries(value)) {
            keys.add(key);
            walk(child);
          }
        }
      };
      walk(exported);
      expect([...keys].filter((key) => forbidden.includes(key))).toEqual([]);

      const json = JSON.stringify(exported);
      expect(json).not.toContain('msg_builder');
      expect(json).not.toContain('ses_root');
      expect(json).not.toContain('abc1234');
    } finally {
      closeLedger(db);
    }
  });
});

describe('the footprint rows', () => {
  it('stores the impact of a message with the method that produced it', () => {
    const impact = estimateRemote(
      {
        outputTokens: 1000,
        inputTokens: 500,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      { totalParamsB: r(300), activeParamsB: r(30), source: 'user' },
      {
        pue: r(1.2),
        wueOnSite: r(0.5),
        wueOffSite: r(1.6),
        gridKgCo2PerKWh: r(0.4),
        source: 'test',
        disclosed: true,
      },
      { ttftS: r(0), tps: r(60) },
    );

    const db = openLedger(root);
    try {
      recordAssistantMessage(db, BUILDER, CTX);
      recordFootprint(db, BUILDER.id, impact);
      const row = db.query('SELECT * FROM footprint').get() as {
        message_id: string;
        energy_lo: number;
        energy_hi: number;
        co2_lo: number;
        co2_hi: number;
        method_version: string;
      };
      expect(row.message_id).toBe(BUILDER.id);
      expect(row.energy_lo).toBe(impact.energyWh[0]);
      expect(row.energy_hi).toBe(impact.energyWh[1]);
      expect(row.energy_lo).toBeLessThanOrEqual(row.energy_hi);
      expect(row.co2_lo).toBeLessThanOrEqual(row.co2_hi);
      expect(row.method_version).toBe(FOOTPRINT_METHOD_VERSION);
    } finally {
      closeLedger(db);
    }
  });
});
