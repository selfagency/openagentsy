import type { ReportScope } from '@openagentsy/core';
import type { openLedger } from '@openagentsy/ledger';

/**
 * The scope of the report, and the rows it selects.
 *
 * A scope is one of three things: a session, a bean or a window. The report
 * says which one it is, and an empty scope is a fact the report prints
 * rather than a gap it fills with zeroes.
 */

/**
 * The ledger's database, as the ledger names it.
 *
 * The type comes from the ledger rather than from `bun:sqlite`, so the CLI
 * does not need the Bun type definitions to talk about the ledger it
 * already opens.
 */
export type LedgerDb = ReturnType<typeof openLedger>;

/** The flags a scope is built from. */
export type ScopeFlags = {
  /** The session, and the subagents that rolled up into it. */
  session?: string | undefined;
  /** The bean: the rows whose task is that bean. */
  bean?: string | undefined;
  /** The window, as a phrase: 30d, 30 days ago, 2 weeks ago. */
  since?: string | undefined;
};

/** The scope the flags name, or the problem with them. */
export type ScopeResult = { ok: true; scope: ReportScope } | { ok: false; error: string };

/** How long a unit of a window is, in milliseconds. */
const UNITS: Record<string, number> = {
  h: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  w: 604_800_000,
  week: 604_800_000,
  weeks: 604_800_000,
  m: 2_592_000_000,
  month: 2_592_000_000,
  months: 2_592_000_000,
};

/**
 * The window a phrase names.
 *
 * The phrase is a number and a unit, with an optional "ago": 30d, 30 days,
 * 30 days ago. A phrase that names no window is no window, and the caller
 * says so rather than guessing a default.
 */
function parseWindow(phrase: string): { days: number; label: string } | undefined {
  const trimmed = phrase
    .trim()
    .toLowerCase()
    .replace(/\s+ago$/, '')
    .trim();
  const found = /^(\d+)\s*([a-z]+)$/.exec(trimmed);
  if (found === null) return undefined;
  const amount = Number(found[1]);
  const unit = found[2];
  if (unit === undefined) return undefined;
  const millis = UNITS[unit];
  if (millis === undefined || !Number.isFinite(amount) || amount <= 0) return undefined;
  const days = Math.round((amount * millis) / 86_400_000);
  if (days <= 0) return undefined;
  return { days, label: `${amount} ${unit}` };
}

/**
 * The scope the flags name.
 *
 * The flags name one thing. Two of them name two things, and a report of
 * two scopes at once is a report of none of them, so the command says the
 * scope is ambiguous and stops.
 */
export function parseScope(flags: ScopeFlags): ScopeResult {
  const named = [
    ...(flags.session === undefined ? [] : [`session ${flags.session}`]),
    ...(flags.bean === undefined ? [] : [`bean ${flags.bean}`]),
    ...(flags.since === undefined ? [] : [`since ${flags.since}`]),
  ];
  if (named.length > 1) {
    return { ok: false, error: `the scope names more than one thing: ${named.join(' and ')}` };
  }
  if (flags.session !== undefined) {
    return { ok: true, scope: { kind: 'session', id: flags.session } };
  }
  if (flags.bean !== undefined) {
    return { ok: true, scope: { kind: 'bean', id: flags.bean } };
  }
  if (flags.since !== undefined) {
    const window = parseWindow(flags.since);
    if (window === undefined) {
      return { ok: false, error: `the window ${flags.since} names no time` };
    }
    return { ok: true, scope: { kind: 'since', days: window.days, label: window.label } };
  }
  return { ok: true, scope: { kind: 'project' } };
}

/** The tables the scope is applied to. */
const TABLES = ['usage', 'waste', 'outcome'] as const;

/**
 * The rows a table holds for the scope.
 *
 * The predicate is the scope, and the parameters are what it names. A
 * project scope selects every row, so the predicate is a tautology and the
 * table is read whole.
 */
function predicate(
  table: (typeof TABLES)[number],
  scope: ReportScope,
  instant: string,
): { sql: string; params: string[] } {
  switch (scope.kind) {
    case 'project':
      return { sql: '1 = 1', params: [] };
    case 'since':
      return { sql: 'ts >= ?', params: [instant] };
    case 'session':
      if (table === 'usage') {
        return { sql: '(root_session_id = ? OR session_id = ?)', params: [scope.id, scope.id] };
      }
      return { sql: 'root_session_id = ?', params: [scope.id] };
    case 'bean':
      if (table === 'waste') {
        return {
          sql: 'message_id IN (SELECT message_id FROM main.usage WHERE task_id = ?)',
          params: [scope.id],
        };
      }
      return { sql: 'task_id = ?', params: [scope.id] };
  }
}

/**
 * Shadow the ledger's tables with the rows the scope selects.
 *
 * The ledger's own queries read the tables by name, and they take no scope:
 * the ledger holds every row it was given. So the scope is applied here,
 * once, by putting the scoped rows into temp tables of the same names. The
 * ledger's queries then read the scope, and the report cannot drift from
 * the ledger, because the report never totals anything itself.
 *
 * The temp tables live in the connection and go with it: nothing is written
 * to the ledger, and a report never changes what it reports on.
 */
export function shadowScope(db: LedgerDb, scope: ReportScope): void {
  const instant =
    scope.kind === 'since'
      ? new Date(Date.now() - scope.days * 86_400_000).toISOString()
      : new Date(0).toISOString();
  for (const table of TABLES) {
    const { sql, params } = predicate(table, scope, instant);
    db.exec(`DROP TABLE IF EXISTS temp.${table}`);
    db.query(`CREATE TEMP TABLE ${table} AS SELECT * FROM main.${table} WHERE ${sql}`).run(
      ...params,
    );
  }
}

/**
 * The days the ledger's own window covers.
 *
 * The ledger's outcome queries look at the last thirty days. A scope that
 * names a window uses that window, and a scope that names a thing opens the
 * ledger's window wide, so the scope alone decides what is in the report.
 */
export function windowDays(scope: ReportScope): number {
  return scope.kind === 'since' ? scope.days : 36_500;
}
