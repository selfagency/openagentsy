import type { DatabaseSync } from 'node:sqlite';
import type { Budget, BudgetDecision } from './types.js';

type BudgetRow = {
  bean: string;
  token_limit: number;
  stop_at: number;
  tokens_used: number;
  updated_at: string;
};

function toBudget(row: BudgetRow): Budget {
  return {
    bean: row.bean,
    tokenLimit: row.token_limit,
    stopAt: row.stop_at,
    tokensUsed: row.tokens_used,
    updatedAt: row.updated_at,
  };
}

/** A builder stops at 85 percent of its budget, before it runs out. */
export const DEFAULT_STOP_RATIO = 0.85;

export type SetBudgetInput = {
  bean: string;
  tokenLimit: number;
  stopAt?: number;
};

export function setBudget(db: DatabaseSync, input: SetBudgetInput): Budget {
  if (!Number.isFinite(input.tokenLimit) || input.tokenLimit <= 0) {
    throw new Error('tokenLimit must be a positive number');
  }
  const stopAt = input.stopAt ?? Math.floor(input.tokenLimit * DEFAULT_STOP_RATIO);
  const updatedAt = new Date().toISOString();

  db.prepare(
    `INSERT INTO budgets (bean, token_limit, stop_at, tokens_used, updated_at)
     VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(bean) DO UPDATE SET
       token_limit = excluded.token_limit,
       stop_at = excluded.stop_at,
       updated_at = excluded.updated_at`,
  ).run(input.bean, input.tokenLimit, stopAt, updatedAt);

  const row = db
    .prepare(
      `SELECT bean, token_limit, stop_at, tokens_used, updated_at FROM budgets WHERE bean = ?`,
    )
    .get(input.bean) as unknown as BudgetRow;
  return toBudget(row);
}

export function recordUsage(
  db: DatabaseSync,
  bean: string,
  tokensUsed: number,
): Budget | undefined {
  const updatedAt = new Date().toISOString();
  const result = db
    .prepare(`UPDATE budgets SET tokens_used = ?, updated_at = ? WHERE bean = ?`)
    .run(tokensUsed, updatedAt, bean);
  if (result.changes === 0) return undefined;
  const row = db
    .prepare(
      `SELECT bean, token_limit, stop_at, tokens_used, updated_at FROM budgets WHERE bean = ?`,
    )
    .get(bean) as unknown as BudgetRow;
  return toBudget(row);
}

export function listBudgets(db: DatabaseSync): Budget[] {
  const rows = db
    .prepare(
      `SELECT bean, token_limit, stop_at, tokens_used, updated_at FROM budgets ORDER BY bean`,
    )
    .all() as unknown as BudgetRow[];
  return rows.map(toBudget);
}

/**
 * Decide whether a bean has to stop. A bean with no budget is not limited,
 * which is reported as `configured: false` so the caller can tell the
 * difference between unlimited and exactly at the limit.
 */
export function checkBudget(db: DatabaseSync, bean: string, tokensUsed: number): BudgetDecision {
  const row = db
    .prepare(
      `SELECT bean, token_limit, stop_at, tokens_used, updated_at FROM budgets WHERE bean = ?`,
    )
    .get(bean) as unknown as BudgetRow | undefined;

  if (!row) {
    return {
      bean,
      tokenLimit: 0,
      stopAt: 0,
      tokensUsed,
      stop: false,
      configured: false,
    };
  }

  const budget = toBudget(row);
  return {
    bean,
    tokenLimit: budget.tokenLimit,
    stopAt: budget.stopAt,
    tokensUsed,
    stop: tokensUsed >= budget.stopAt,
    configured: true,
  };
}
