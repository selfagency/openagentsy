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

/**
 * Record what a bean has spent.
 *
 * The number is a snapshot, not a running total: the caller reports what it
 * has spent so far, and the board holds the last report. A report that is
 * lower than the one before it is kept, because a lower number is a
 * measurement that went backwards, not a budget that got smaller.
 */
export function recordUsage(
  db: BoardDatabase,
  bean: string,
  tokensUsed: number,
): Budget | undefined {
  const updatedAt = new Date().toISOString();
  const current = db.select().from(budgets).where(eq(budgets.bean, bean)).get();
  const reported = current && current.tokensUsed > tokensUsed ? current.tokensUsed : tokensUsed;
  const updated = db
    .update(budgets)
    .set({ tokensUsed: reported, updatedAt })
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
 *
 * The caller reports what it has spent, and the board holds the last
 * report. The higher of the two counts: a caller that does not know what
 * it spent reports zero, and a bean that is over its budget is over it
 * whoever asks.
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
  const spent = Math.max(budget.tokensUsed, tokensUsed);
  return {
    bean,
    tokenLimit: budget.tokenLimit,
    stopAt: budget.stopAt,
    tokensUsed: spent,
    stop: spent >= budget.stopAt,
    configured: true,
  };
}
