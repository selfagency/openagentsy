import { eq } from 'drizzle-orm';
import type { BoardDatabase } from './db.js';
import { budgets } from './schema.js';
import type { Budget, BudgetDecision } from './types.js';

type BudgetRow = typeof budgets.$inferSelect;

function toBudget(row: BudgetRow): Budget {
  return {
    bean: row.bean,
    tokenLimit: row.tokenLimit,
    stopAt: row.stopAt,
    tokensUsed: row.tokensUsed,
    updatedAt: row.updatedAt,
  };
}

/** A builder stops at 85 percent of its budget, before it runs out. */
export const DEFAULT_STOP_RATIO = 0.85;

export type SetBudgetInput = {
  bean: string;
  tokenLimit: number;
  stopAt?: number;
};

export function setBudget(db: BoardDatabase, input: SetBudgetInput): Budget {
  if (!Number.isFinite(input.tokenLimit) || input.tokenLimit <= 0) {
    throw new Error('tokenLimit must be a positive number');
  }
  const stopAt = input.stopAt ?? Math.floor(input.tokenLimit * DEFAULT_STOP_RATIO);
  const updatedAt = new Date().toISOString();

  const upserted = db
    .insert(budgets)
    .values({ bean: input.bean, tokenLimit: input.tokenLimit, stopAt, tokensUsed: 0, updatedAt })
    .onConflictDoUpdate({
      target: budgets.bean,
      set: { tokenLimit: input.tokenLimit, stopAt, updatedAt },
    })
    .returning()
    .get();
  return toBudget(upserted);
}

export function recordUsage(
  db: BoardDatabase,
  bean: string,
  tokensUsed: number,
): Budget | undefined {
  const updatedAt = new Date().toISOString();
  const updated = db
    .update(budgets)
    .set({ tokensUsed, updatedAt })
    .where(eq(budgets.bean, bean))
    .returning()
    .get();
  return updated ? toBudget(updated) : undefined;
}

export function listBudgets(db: BoardDatabase): Budget[] {
  const rows = db.select().from(budgets).orderBy(budgets.bean).all();
  return rows.map(toBudget);
}

/**
 * Decide whether a bean has to stop. A bean with no budget is not limited,
 * which is reported as `configured: false` so the caller can tell the
 * difference between unlimited and exactly at the limit.
 */
export function checkBudget(db: BoardDatabase, bean: string, tokensUsed: number): BudgetDecision {
  const row = db.select().from(budgets).where(eq(budgets.bean, bean)).get();

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
