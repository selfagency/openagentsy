import type { Database } from 'bun:sqlite';
import type { TokenCounts } from './pricing.js';

/**
 * The queries (§6.5).
 *
 * A token count follows the plan: the tokens of a message are its input, its
 * output, its reasoning and its cache writes. The tokens read from the cache
 * are left out, because they were paid for when they were written and
 * counting them twice would make every number on the board too large.
 */

const TOKENS = '(input + output + reasoning + cache_write)';

function n(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export type RoleTotals = {
  role: string;
  messages: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  tokens: number;
  usd: number | null;
  unpriced: number;
};

export type TaskTotals = {
  taskId: string;
  messages: number;
  tokens: number;
  usd: number | null;
};

export type TaskOutcome = {
  taskId: string;
  tokens: number;
  usd: number | null;
};

export type CommitOutcome = {
  commitSha: string;
  tokens: number;
  usd: number | null;
};

export type WasteTotals = {
  tokens: number;
  percentage: number;
};

export type OutcomeTotals = {
  tasksCompleted: number;
  tasksScrapped: number;
  commits: number;
  prsMerged: number;
};

export type OffloadRow = {
  messageId: string;
  provider: string;
  model: string;
  tokens: number;
  usd: number | null;
};

export type LedgerTotals = {
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

/**
 * The totals per resolved role.
 *
 * A backfilled row carries the unresolved agent id in `role_raw`, and it is
 * left out: it cannot be attributed, and a report that guessed would be
 * wrong in a way nobody can see.
 */
export function perRoleTotals(db: Database): RoleTotals[] {
  const rows = db
    .query(
      `SELECT role,
        COUNT(*) AS messages,
        SUM(input) AS input,
        SUM(output) AS output,
        SUM(reasoning) AS reasoning,
        SUM(cache_read) AS cache_read,
        SUM(cache_write) AS cache_write,
        SUM(${TOKENS}) AS tokens,
        SUM(COALESCE(cost_reported, cost_estimated)) AS usd,
        SUM(CASE WHEN COALESCE(cost_reported, cost_estimated) IS NULL THEN 1 ELSE 0 END) AS unpriced
      FROM usage
      WHERE role IS NOT NULL AND role_raw IS NULL
      GROUP BY role
      ORDER BY tokens DESC`,
    )
    .all() as Record<string, unknown>[];

  return rows.map((row) => ({
    role: String(row.role ?? ''),
    messages: n(row.messages),
    input: n(row.input),
    output: n(row.output),
    reasoning: n(row.reasoning),
    cacheRead: n(row.cache_read),
    cacheWrite: n(row.cache_write),
    tokens: n(row.tokens),
    usd: optionalNumber(row.usd),
    unpriced: n(row.unpriced),
  }));
}

/** The totals per task. */
export function perTaskTotals(db: Database): TaskTotals[] {
  const rows = db
    .query(
      `SELECT task_id,
        COUNT(*) AS messages,
        SUM(${TOKENS}) AS tokens,
        SUM(COALESCE(cost_reported, cost_estimated)) AS usd
      FROM usage
      WHERE task_id IS NOT NULL
      GROUP BY task_id
      ORDER BY tokens DESC`,
    )
    .all() as Record<string, unknown>[];

  return rows.map((row) => ({
    taskId: String(row.task_id ?? ''),
    messages: n(row.messages),
    tokens: n(row.tokens),
    usd: optionalNumber(row.usd),
  }));
}

/** The tokens of one task, joined to the outcome that closed it. */
export function tokensPerCompletedTask(db: Database, days = 30): TaskOutcome[] {
  const rows = db
    .query(
      `SELECT o.task_id, SUM(u.input + u.output + u.reasoning + u.cache_write) AS tokens,
        SUM(COALESCE(u.cost_reported, u.cost_estimated)) AS usd
      FROM outcome o JOIN usage u ON u.task_id = o.task_id
      WHERE o.kind = 'task_completed' AND o.ts > datetime('now', ?)
      GROUP BY o.task_id`,
    )
    .all(`-${days} days`) as Record<string, unknown>[];

  return rows.map((row) => ({
    taskId: String(row.task_id ?? ''),
    tokens: n(row.tokens),
    usd: optionalNumber(row.usd),
  }));
}

/** The tokens of one commit, joined to the outcome that recorded it. */
export function tokensPerCommit(db: Database, days = 30): CommitOutcome[] {
  const rows = db
    .query(
      `SELECT o.commit_sha, SUM(u.input + u.output + u.reasoning + u.cache_write) AS tokens,
        SUM(COALESCE(u.cost_reported, u.cost_estimated)) AS usd
      FROM outcome o JOIN usage u ON u.task_id = o.task_id
      WHERE o.kind = 'commit' AND o.commit_sha IS NOT NULL AND o.ts > datetime('now', ?)
      GROUP BY o.commit_sha`,
    )
    .all(`-${days} days`) as Record<string, unknown>[];

  return rows.map((row) => ({
    commitSha: String(row.commit_sha ?? ''),
    tokens: n(row.tokens),
    usd: optionalNumber(row.usd),
  }));
}

/** The waste tokens and the share of the total they are. */
export function wasteTotals(db: Database): WasteTotals {
  const row = db
    .query(
      `SELECT (SELECT COALESCE(SUM(tokens), 0) FROM waste) AS waste_tokens,
        (SELECT COALESCE(SUM(${TOKENS}), 0) FROM usage) AS total_tokens`,
    )
    .get() as Record<string, unknown> | null;

  const waste = n(row?.waste_tokens);
  const total = n(row?.total_tokens);
  return { tokens: waste, percentage: total > 0 ? (waste / total) * 100 : 0 };
}

export type WasteKindTotals = {
  kind: string;
  count: number;
  tokens: number;
  /** The share of the waste tokens, in percent. */
  percentage: number;
};

/**
 * The waste tokens per kind, and the share each kind is of the waste.
 *
 * The kinds are the seven of §6.4, and the ones with no rows are simply
 * absent: a kind that never happened does not need a line in a report.
 */
export function wasteByKind(db: Database): WasteKindTotals[] {
  const rows = db
    .query(
      `SELECT kind, COUNT(*) AS count, SUM(tokens) AS tokens
       FROM waste GROUP BY kind ORDER BY tokens DESC, kind`,
    )
    .all() as Record<string, unknown>[];

  const totals = wasteTotals(db);
  return rows.map((row) => {
    const tokens = n(row.tokens);
    return {
      kind: String(row.kind ?? ''),
      count: n(row.count),
      tokens,
      percentage: totals.tokens > 0 ? (tokens / totals.tokens) * 100 : 0,
    };
  });
}

export type ResultTotals = {
  tasksCompleted: number;
  /** The tokens one completed task cost; null when there is no task. */
  tokensPerTask: number | null;
  commits: number;
  /** The tokens one commit cost; null when there is no commit. */
  tokensPerCommit: number | null;
  prsMerged: number;
};

/**
 * The exit metrics of §6.5: the tokens per completed task and the tokens per
 * commit.
 *
 * They are built on the two joins that are already there, so the number a
 * report shows and the number the task list shows are the same number.
 */
export function tokensPerResult(db: Database, days = 30): ResultTotals {
  const tasks = tokensPerCompletedTask(db, days);
  const commits = tokensPerCommit(db, days);
  const outcomes = outcomeTotals(db);
  const taskTokens = tasks.reduce((sum, row) => sum + row.tokens, 0);
  const commitTokens = commits.reduce((sum, row) => sum + row.tokens, 0);
  return {
    tasksCompleted: tasks.length,
    tokensPerTask: tasks.length > 0 ? taskTokens / tasks.length : null,
    commits: commits.length,
    tokensPerCommit: commits.length > 0 ? commitTokens / commits.length : null,
    prsMerged: outcomes.prsMerged,
  };
}

/** How many outcomes of each kind there are. */
export function outcomeTotals(db: Database): OutcomeTotals {
  const rows = db
    .query('SELECT kind, COUNT(*) AS count FROM outcome GROUP BY kind')
    .all() as Record<string, unknown>[];

  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(String(row.kind ?? ''), n(row.count));
  }
  return {
    tasksCompleted: counts.get('task_completed') ?? 0,
    tasksScrapped: counts.get('task_scrapped') ?? 0,
    commits: counts.get('commit') ?? 0,
    prsMerged: counts.get('pr_merged') ?? 0,
  };
}

/** The totals of every message. */
export function ledgerTotals(db: Database): LedgerTotals {
  const row = db
    .query(
      `SELECT COUNT(*) AS messages,
        SUM(${TOKENS}) AS tokens,
        SUM(input) AS input,
        SUM(output) AS output,
        SUM(reasoning) AS reasoning,
        SUM(cache_read) AS cache_read,
        SUM(cache_write) AS cache_write,
        SUM(COALESCE(cost_reported, cost_estimated)) AS usd,
        SUM(CASE WHEN COALESCE(cost_reported, cost_estimated) IS NULL THEN 1 ELSE 0 END) AS unpriced
      FROM usage`,
    )
    .get() as Record<string, unknown> | null;

  return {
    messages: n(row?.messages),
    tokens: n(row?.tokens),
    input: n(row?.input),
    output: n(row?.output),
    reasoning: n(row?.reasoning),
    cacheRead: n(row?.cache_read),
    cacheWrite: n(row?.cache_write),
    usd: optionalNumber(row?.usd),
    unpricedMessages: n(row?.unpriced),
  };
}

/** The rows of the offloaded work. */
export function offloadRows(db: Database): OffloadRow[] {
  const rows = db
    .query(
      `SELECT message_id, provider, model, ${TOKENS} AS tokens,
        COALESCE(cost_reported, cost_estimated) AS usd
      FROM usage
      WHERE role = 'offload'
      ORDER BY tokens DESC`,
    )
    .all() as Record<string, unknown>[];

  return rows.map((row) => ({
    messageId: String(row.message_id ?? ''),
    provider: String(row.provider ?? ''),
    model: String(row.model ?? ''),
    tokens: n(row.tokens),
    usd: optionalNumber(row.usd),
  }));
}

/** The price of some tokens, looked up by the caller. */
export type PriceLookup = (
  provider: string,
  model: string,
  tokens: TokenCounts,
) => Promise<number | null>;

export type OffloadSavings = {
  messages: number;
  tokens: number;
  /** What the local run cost. */
  usd: number | null;
  /** What the same tokens would have cost on the cloud. */
  cloudUsd: number | null;
  /** The difference, when both numbers are known. */
  savedUsd: number | null;
};

/**
 * The savings of the offloaded work.
 *
 * The cloud price of a local run is the price the same tokens would have
 * had on the model the job would otherwise have used, so the lookup is the
 * caller's: the ledger knows the token counts, and only the caller knows
 * which cloud model was avoided. A lookup that knows nothing leaves the
 * cloud price empty rather than pretending it was free.
 */
export async function offloadSavings(db: Database, price: PriceLookup): Promise<OffloadSavings> {
  const rows = offloadRows(db);
  let tokens = 0;
  let usd: number | null = null;
  let cloudUsd: number | null = null;

  for (const row of rows) {
    tokens += row.tokens;
    if (row.usd !== null) usd = (usd ?? 0) + row.usd;
    const cloud = await price(row.provider, row.model, {
      input: 0,
      output: row.tokens,
    });
    if (cloud !== null) cloudUsd = (cloudUsd ?? 0) + cloud;
  }

  return {
    messages: rows.length,
    tokens,
    usd,
    cloudUsd,
    savedUsd: usd !== null && cloudUsd !== null ? cloudUsd - usd : null,
  };
}
