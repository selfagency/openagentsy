import type { Database } from 'bun:sqlite';

/**
 * The ledger's schema.
 *
 * Numbers only: token counts, model ids, timestamps, task ids and commit
 * shas. A prompt, a completion or a line of code never reaches this
 * database — the transcripts stay in OpenCode's own storage, and the ledger
 * only ever holds the counters.
 */

/** The role keys the resolver hands the ledger (§6.1). */
export const ROLE_KEYS = [
  'lead',
  'scout',
  'researcher',
  'builder',
  'reviewer',
  'advisor',
  'archivist',
  'offload',
] as const;

export type RoleKey = (typeof ROLE_KEYS)[number];

/** The waste signals of §6.4. */
export const WASTE_KINDS = [
  'retry',
  'tool_error_loop',
  'interrupted',
  'undo',
  'reverted_code',
  'cache_miss',
  'no_progress',
] as const;

export type WasteKind = (typeof WASTE_KINDS)[number];

/** The outcome kinds of §6.5. */
export const OUTCOME_KINDS = ['task_completed', 'task_scrapped', 'commit', 'pr_merged'] as const;

export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

/** The list a CHECK constraint takes. */
function kindList(kinds: readonly string[]): string {
  return kinds.map((kind) => `'${kind}'`).join(',');
}

/**
 * The tables.
 *
 * `usage` carries the resolved role: the `role` column is the role key the
 * adapter resolved, and `role_raw` holds the unresolved agent id of a
 * backfilled row, which no per-role report counts.
 *
 * The two REV3 tables are schema only for now: their writers land in 2f.
 * `policy_firing` carries the audit columns of REV3 §21.3 next to the
 * classification and the detail, so the trace survives.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS usage (
  message_id      TEXT PRIMARY KEY,        -- dedup key (OpenCode message id)
  session_id      TEXT NOT NULL,
  root_session_id TEXT NOT NULL,           -- Lead session; subagents roll up here
  role            TEXT,                    -- RESOLVED role key
  role_raw        TEXT,                    -- unresolved agent id, backfilled rows only
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  input           INTEGER NOT NULL DEFAULT 0,
  output          INTEGER NOT NULL DEFAULT 0,
  reasoning       INTEGER NOT NULL DEFAULT 0,
  cache_read      INTEGER NOT NULL DEFAULT 0,
  cache_write     INTEGER NOT NULL DEFAULT 0,
  cost_reported   REAL,                    -- from OpenCode message.cost, if present
  cost_estimated  REAL,                    -- from pricing chain; NULL = unpriced (never 0)
  latency_ms      INTEGER,
  task_id         TEXT,                    -- in-progress task at the time, if any
  ts              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_root ON usage(root_session_id);
CREATE INDEX IF NOT EXISTS usage_task ON usage(task_id);

CREATE TABLE IF NOT EXISTS waste (
  id INTEGER PRIMARY KEY, root_session_id TEXT, message_id TEXT,
  kind TEXT CHECK (kind IN (${kindList(WASTE_KINDS)})),
  tokens INTEGER NOT NULL, detail TEXT, ts TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outcome (
  id INTEGER PRIMARY KEY, root_session_id TEXT, task_id TEXT, commit_sha TEXT,
  kind TEXT CHECK (kind IN (${kindList(OUTCOME_KINDS)})), ts TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS footprint (
  message_id TEXT PRIMARY KEY REFERENCES usage(message_id),
  energy_lo REAL, energy_hi REAL, water_lo REAL, water_hi REAL,
  co2_lo REAL, co2_hi REAL, method_version TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS policy_firing (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  policy_version TEXT,
  layer INTEGER,
  action TEXT NOT NULL,
  severity TEXT,
  reason TEXT,
  finding_id TEXT,
  classification TEXT,
  detail TEXT,
  origin TEXT,                     -- 'first-party' | 'external' (§21)
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_policy_firing_session ON policy_firing(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_policy_firing_policy ON policy_firing(policy_id, ts);

CREATE TABLE IF NOT EXISTS safety_metric (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  session_id TEXT,
  metric TEXT NOT NULL,
  value REAL,
  cohort TEXT
);
`;

/**
 * The columns the policy_firing table gained after it was first written.
 *
 * A ledger that was written before a column existed still has to take the
 * rows of the policies that fire now, so the column is added on open. The
 * check makes it happen once: a column that is there is not added again.
 */
const POLICY_FIRING_COLUMNS: readonly { name: string; ddl: string }[] = [
  { name: 'origin', ddl: 'ALTER TABLE policy_firing ADD COLUMN origin TEXT' },
];

/** Add the columns a ledger that was written before does not have. */
function migratePolicyFiring(db: Database): void {
  const columns = db.query('PRAGMA table_info(policy_firing)').all() as { name: string }[];
  const names = new Set(columns.map((column) => column.name));
  for (const column of POLICY_FIRING_COLUMNS) {
    if (names.has(column.name)) continue;
    db.exec(column.ddl);
  }
}

/** Bring the database up to the schema. Opening twice changes nothing. */
export function applySchema(db: Database): void {
  db.exec(SCHEMA_SQL);
  migratePolicyFiring(db);
}
