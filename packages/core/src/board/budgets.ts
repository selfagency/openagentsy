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
    ...(row.turnLimit !== null ? { turnLimit: row.turnLimit } : {}),
    ...(row.sessionLimit !== null ? { sessionLimit: row.sessionLimit } : {}),
    ...(row.warned !== null ? { warned: row.warned } : {}),
    updatedAt: row.updatedAt,
  };
}

/** A builder stops at 85 percent of its budget, before it runs out. */
export const DEFAULT_STOP_RATIO = 0.85;

/**
 * The share of a cap that opens the yellow window.
 *
 * The window is the warning that comes before the stop: the builder is told
 * at eighty percent that it is close, and it stops at eighty-five.
 */
export const YELLOW_RATIO = 0.8;

/**
 * A reading of what a bean has spent, measured somewhere else.
 *
 * The ledger is the measurement (§6.7): the board asks for a bean's usage and
 * the ledger answers with the tokens it counted. A reader that has nothing to
 * say answers with `undefined`, and the check falls back to what the board
 * already holds.
 */
export type UsageReader = (bean: string) => number | undefined;

/**
 * The measurements one check needs.
 *
 * The bean's total is the cap that was there first. The turn and the session
 * caps came with REV3 §6.7, and each is read on its own: what a bean spent in
 * total says nothing about what one turn cost.
 */
export type UsageReaders = {
  /** What the bean has spent, in total. */
  total?: UsageReader | undefined;
  /** What the most expensive turn cost. */
  turn?: UsageReader | undefined;
  /** What the most expensive session cost. */
  session?: UsageReader | undefined;
};

export type SetBudgetInput = {
  bean: string;
  tokenLimit: number;
  stopAt?: number;
  /** The cap of a single turn. */
  turnLimit?: number | undefined;
  /** The cap of a single session. */
  sessionLimit?: number | undefined;
};

/** A cap that is a number, or nothing. */
function positive(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('a cap must be a positive number');
  }
  return Math.floor(value);
}

export function setBudget(db: BoardDatabase, input: SetBudgetInput): Budget {
  if (!Number.isFinite(input.tokenLimit) || input.tokenLimit <= 0) {
    throw new Error('tokenLimit must be a positive number');
  }
  const stopAt = input.stopAt ?? Math.floor(input.tokenLimit * DEFAULT_STOP_RATIO);
  const turnLimit = positive(input.turnLimit);
  const sessionLimit = positive(input.sessionLimit);
  const updatedAt = new Date().toISOString();

  const upserted = db
    .insert(budgets)
    .values({
      bean: input.bean,
      tokenLimit: input.tokenLimit,
      stopAt,
      tokensUsed: 0,
      ...(turnLimit !== undefined ? { turnLimit } : {}),
      ...(sessionLimit !== undefined ? { sessionLimit } : {}),
      updatedAt,
    })
    .onConflictDoUpdate({
      target: budgets.bean,
      set: {
        tokenLimit: input.tokenLimit,
        stopAt,
        updatedAt,
        // A cap the caller did not name is left as it was: the tool sets the
        // caps it is given, and a cap that is not named is not removed.
        ...(turnLimit !== undefined ? { turnLimit } : {}),
        ...(sessionLimit !== undefined ? { sessionLimit } : {}),
      },
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
 *
 * Deprecated in 2b: the ledger measures the usage and the budget check reads
 * it there (§6.7). This path keeps working for the old clients, and it is
 * removed in 2c.
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

/** The scopes a cap can have. */
export type CapScope = 'bean' | 'turn' | 'session';

/** One cap, and what was spent against it. */
type Cap = {
  scope: CapScope;
  limit: number;
  used: number | undefined;
};

/** The share of the cap that is spent, as a percentage. */
function percent(used: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.round((used / limit) * 100);
}

/**
 * The yellow window, and the warning it owes.
 *
 * The warning is owed once per crossing: the row remembers that it warned,
 * and a check that finds the row still marked does not warn again. A check
 * that finds the bean back under the window clears the mark, so the next
 * crossing warns again.
 */
function yellowWindow(db: BoardDatabase, row: BudgetRow, caps: Cap[]): string | undefined {
  const crossed = caps.filter(
    (cap) => cap.used !== undefined && cap.used > cap.limit * YELLOW_RATIO,
  );

  if (crossed.length === 0) {
    if (row.warned !== null) {
      db.update(budgets).set({ warned: null }).where(eq(budgets.bean, row.bean)).run();
    }
    return undefined;
  }

  if (row.warned !== null) return undefined;

  const cap = crossed[0];
  if (cap === undefined || cap.used === undefined) return undefined;

  db.update(budgets).set({ warned: cap.scope }).where(eq(budgets.bean, row.bean)).run();
  return `The ${cap.scope} cap is in the yellow window: ${cap.used} of ${cap.limit} tokens, ${percent(cap.used, cap.limit)} percent.`;
}

/**
 * The decision for a bean that has no budget.
 *
 * A bean with no budget is not limited, and that is reported as
 * `configured: false` so the caller can tell the difference between
 * unlimited and exactly at the limit.
 */
function unconfigured(bean: string, tokensUsed: number): BudgetDecision {
  return {
    bean,
    tokenLimit: 0,
    stopAt: 0,
    tokensUsed,
    stop: false,
    configured: false,
    turnStop: false,
    sessionStop: false,
  };
}

/**
 * Whether a measurement went over its cap.
 *
 * A cap that was not measured never stopped anything: a missing reading is
 * not a verdict.
 */
function overCap(limit: number | undefined, used: number | undefined): boolean {
  if (limit === undefined) return false;
  if (used === undefined) return false;
  return used >= limit;
}

/** The caps of a budget, with what was spent against each of them. */
function capsOf(
  budget: Budget,
  spent: number,
  turnTokens?: number | undefined,
  sessionTokens?: number | undefined,
): Cap[] {
  const caps: Cap[] = [{ scope: 'bean', limit: budget.tokenLimit, used: spent }];
  if (budget.turnLimit !== undefined) {
    caps.push({ scope: 'turn', limit: budget.turnLimit, used: turnTokens });
  }
  if (budget.sessionLimit !== undefined) {
    caps.push({ scope: 'session', limit: budget.sessionLimit, used: sessionTokens });
  }
  return caps;
}

/** The caps a budget carries, in the shape the decision carries them. */
function limitsOf(budget: Budget): { turnLimit?: number; sessionLimit?: number } {
  return {
    ...(budget.turnLimit !== undefined ? { turnLimit: budget.turnLimit } : {}),
    ...(budget.sessionLimit !== undefined ? { sessionLimit: budget.sessionLimit } : {}),
  };
}

/** The measurements a check made, in the shape the decision carries them. */
function readingsOf(
  turnTokens?: number | undefined,
  sessionTokens?: number | undefined,
): { turnTokens?: number; sessionTokens?: number } {
  return {
    ...(turnTokens !== undefined ? { turnTokens } : {}),
    ...(sessionTokens !== undefined ? { sessionTokens } : {}),
  };
}

/**
 * Decide whether a bean has to stop.
 *
 * The cap stays in the board and the usage comes from the ledger (§6.7): the
 * reader is asked what the bean spent, and that number is what the cap is
 * compared against. A reader that has nothing to say — no ledger, no row for
 * the bean — falls back to the self-reported usage the board already holds,
 * which is the behaviour that landed. The fallback is a fallback, not a
 * crash: a board without a ledger keeps working.
 */
export function checkBudget(
  db: BoardDatabase,
  bean: string,
  tokensUsed: number,
  readers?: UsageReaders,
): BudgetDecision {
  const row = db.select().from(budgets).where(eq(budgets.bean, bean)).get();
  if (!row) return unconfigured(bean, tokensUsed);

  const budget = toBudget(row);
  const measured = readers?.total?.(bean);
  const turnTokens = readers?.turn?.(bean);
  const sessionTokens = readers?.session?.(bean);

  // The ledger is the measurement. When it has a number, that is what the
  // bean spent, and the self-report is ignored: the whole point of the split
  // is that nobody reports their own usage any more.
  const spent = measured ?? Math.max(budget.tokensUsed, tokensUsed);

  const warning = yellowWindow(db, row, capsOf(budget, spent, turnTokens, sessionTokens));

  return {
    bean,
    tokenLimit: budget.tokenLimit,
    stopAt: budget.stopAt,
    tokensUsed: spent,
    stop: spent >= budget.stopAt,
    configured: true,
    ...limitsOf(budget),
    ...readingsOf(turnTokens, sessionTokens),
    turnStop: overCap(budget.turnLimit, turnTokens),
    sessionStop: overCap(budget.sessionLimit, sessionTokens),
    ...(warning !== undefined ? { warning } : {}),
  };
}
