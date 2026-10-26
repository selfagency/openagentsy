import { Database } from 'bun:sqlite';
import {
  ledgerTotals,
  offloadRows,
  outcomeTotals,
  perRoleTotals,
  perTaskTotals,
  tokensPerCompletedTask,
  wasteTotals,
} from './query.js';
import { applySchema } from './schema.js';

/**
 * The export (§6.6).
 *
 * Counters only. No prompt, no completion, no code, no message id and no
 * session id: the export is a set of numbers with the names of a role and a
 * task, so a person can read what the work cost without reading the work.
 * Nothing is uploaded, and there is no leaderboard.
 */

/** The version of the export shape. */
export const EXPORT_SCHEMA = 'openagentsy.ledger/v1';

export type LedgerExport = {
  schema: string;
  generatedAt: string;
  totals: {
    messages: number;
    tokens: number;
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
    usd: number | null;
    unpricedMessages: number;
  };
  byRole: {
    role: string;
    messages: number;
    tokens: number;
    usd: number | null;
    unpriced: number;
  }[];
  byTask: {
    taskId: string;
    messages: number;
    tokens: number;
    usd: number | null;
  }[];
  waste: { tokens: number; percentage: number };
  outcomes: {
    tasksCompleted: number;
    tasksScrapped: number;
    commits: number;
    prsMerged: number;
  };
  /** The mean tokens of a completed task, when there is one. */
  tokensPerCompletedTask: number | null;
  offload: { messages: number; tokens: number; usd: number | null };
};

export type ExportOptions = {
  /** The clock, so a test can pin the stamp. */
  generatedAt?: string;
};

/** The counters of the ledger, ready to be written as JSON. */
export function ledgerExport(db: Database, options: ExportOptions = {}): LedgerExport {
  const totals = ledgerTotals(db);
  const roles = perRoleTotals(db);
  const tasks = perTaskTotals(db);
  const waste = wasteTotals(db);
  const outcomes = outcomeTotals(db);
  const offload = offloadRows(db);
  const completed = tokensPerCompletedTask(db);

  const offloadTokens = offload.reduce((sum, row) => sum + row.tokens, 0);
  const offloadUsd = offload.some((row) => row.usd !== null)
    ? offload.reduce((sum, row) => sum + (row.usd ?? 0), 0)
    : null;
  const completedTokens = completed.reduce((sum, row) => sum + row.tokens, 0);

  return {
    schema: EXPORT_SCHEMA,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    totals: {
      messages: totals.messages,
      tokens: totals.tokens,
      input: totals.input,
      output: totals.output,
      reasoning: totals.reasoning,
      cacheRead: totals.cacheRead,
      cacheWrite: totals.cacheWrite,
      usd: totals.usd,
      unpricedMessages: totals.unpricedMessages,
    },
    byRole: roles.map((row) => ({
      role: row.role,
      messages: row.messages,
      tokens: row.tokens,
      usd: row.usd,
      unpriced: row.unpriced,
    })),
    byTask: tasks.map((row) => ({
      taskId: row.taskId,
      messages: row.messages,
      tokens: row.tokens,
      usd: row.usd,
    })),
    waste: { tokens: waste.tokens, percentage: waste.percentage },
    outcomes,
    tokensPerCompletedTask: completed.length > 0 ? completedTokens / completed.length : null,
    offload: { messages: offload.length, tokens: offloadTokens, usd: offloadUsd },
  };
}

/**
 * The export of a ledger with nothing in it.
 *
 * A project that has no ledger yet has nothing to show, and reading it
 * should not create one, so the zeros come from a database that lives only
 * for the length of the call.
 */
export function emptyLedgerExport(generatedAt?: string): LedgerExport {
  const db = new Database(':memory:');
  try {
    applySchema(db);
    return ledgerExport(db, generatedAt === undefined ? {} : { generatedAt });
  } finally {
    db.close();
  }
}
