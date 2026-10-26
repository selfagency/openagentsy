import { access } from 'node:fs/promises';
import { join } from 'node:path';
import {
  closeLedger,
  detectCacheMiss,
  detectNoProgressAtPath,
  emptyLedgerExport,
  type LedgerExport,
  ledgerExport,
  ledgerPath,
  openLedger,
  recordOutcome,
  recordWasteRows,
  scanRefsTrailers,
  scanReverts,
  scanTaskTransitions,
  type TaskReader,
  type WasteKindTotals,
  type WasteTotals,
  wasteByKind,
  wasteTotals,
} from '@openagentsy/ledger';

/**
 * The ledger, as a person reads it.
 *
 * The numbers only: how many messages, how many tokens, what they cost,
 * what the waste was and what came of the work. There is no transcript
 * here, and there never will be: the ledger holds counters, so a report
 * can say what the work cost without ever holding the work.
 */

export type LedgerReport = {
  root: string;
  databasePath: string;
  exists: boolean;
  counters: LedgerExport;
};

export async function runLedger(root: string): Promise<LedgerReport> {
  const databasePath = ledgerPath(root);
  // A project that has no ledger yet has nothing to show, and reading it
  // should not create one.
  const exists = await access(databasePath).then(
    () => true,
    () => false,
  );
  if (!exists) {
    return { root, databasePath, exists: false, counters: emptyLedgerExport() };
  }

  const db = openLedger(root);
  try {
    return { root, databasePath, exists: true, counters: ledgerExport(db) };
  } finally {
    closeLedger(db);
  }
}

/** A price, or the word for a price nobody knows. */
function money(usd: number | null): string {
  return usd === null ? 'unpriced' : `$${usd.toFixed(4)}`;
}

function field(label: string, value: string): string {
  return `  ${label.padEnd(12)}${value}`;
}

/** The number of tokens, with the thousands separated. */
function tokens(value: number): string {
  return value.toLocaleString('en-US');
}

export function formatLedgerReport(report: LedgerReport): string {
  const lines: string[] = [];
  const counters = report.counters;

  lines.push('ledger');
  lines.push(field('database', `${report.databasePath} ${report.exists ? 'found' : 'missing'}`));
  lines.push(field('messages', String(counters.totals.messages)));
  lines.push(field('tokens', tokens(counters.totals.tokens)));
  lines.push(field('cost', money(counters.totals.usd)));
  lines.push(field('unpriced', `${counters.totals.unpricedMessages} message(s)`));

  lines.push('');
  lines.push('by role');
  if (counters.byRole.length === 0) {
    lines.push('  (none)');
  }
  for (const role of counters.byRole) {
    lines.push(`  ${role.role.padEnd(14)}${tokens(role.tokens).padStart(10)}   ${money(role.usd)}`);
  }

  lines.push('');
  lines.push('by task');
  if (counters.byTask.length === 0) {
    lines.push('  (none)');
  }
  for (const task of counters.byTask) {
    lines.push(
      `  ${task.taskId.padEnd(14)}${tokens(task.tokens).padStart(10)}   ${money(task.usd)}`,
    );
  }

  lines.push('');
  lines.push('waste');
  lines.push(
    field('tokens', `${tokens(counters.waste.tokens)} (${counters.waste.percentage.toFixed(1)}%)`),
  );

  lines.push('');
  lines.push('outcomes');
  lines.push(
    field(
      'tasks',
      `${counters.outcomes.tasksCompleted} completed, ${counters.outcomes.tasksScrapped} scrapped`,
    ),
  );
  lines.push(
    field(
      'commits',
      `${counters.outcomes.commits} commit(s), ${counters.outcomes.prsMerged} merged`,
    ),
  );
  lines.push(
    field(
      'per task',
      counters.tokensPerCompletedTask === null
        ? 'unpriced'
        : `${tokens(counters.tokensPerCompletedTask)} tokens`,
    ),
  );

  lines.push('');
  lines.push('offload');
  lines.push(
    field(
      'messages',
      `${counters.offload.messages} message(s), ${tokens(counters.offload.tokens)} tokens`,
    ),
  );
  lines.push(field('cost', money(counters.offload.usd)));

  return `${lines.join('\n')}\n`;
}

/**
 * The waste, as a person reads it.
 *
 * The command finds the waste it can find on its own — the cache misses and
 * the rounds of the Lead that went nowhere — writes it down and then says
 * what the waste is: how many signals of each kind, how many tokens they
 * were and what share of the tokens that is. The hook-driven kinds of §6.4
 * are counted here too, because the event bridge writes them into the same
 * table; this command does not find them.
 */

export type LedgerWasteReport = {
  root: string;
  /** The signals this run wrote. */
  written: number;
  byKind: WasteKindTotals[];
  totals: WasteTotals;
};

/** What the waste command needs to know. */
export type LedgerWasteOptions = {
  /** Only the rounds that closed after this instant. */
  since?: string | undefined;
  /** Where OpenCode keeps its storage. */
  dataDir?: string | undefined;
  /** The agent id the Lead writes its records under. */
  leadAgent?: string | undefined;
};

/**
 * The board of a project, at the path the board keeps it.
 */
function boardPath(root: string): string {
  return join(root, '.openagentsy', 'board.sqlite');
}

/**
 * Find the waste that can be found without the event bridge, and say what
 * the waste is.
 */
export async function runLedgerWaste(
  root: string,
  options: LedgerWasteOptions = {},
): Promise<LedgerWasteReport> {
  const since = options.since ?? '30 days ago';
  const instant = instantOf(since);
  const db = openLedger(root);
  try {
    const candidates = [
      ...detectCacheMiss(db, {
        ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
        since: instant,
      }),
      ...detectNoProgressAtPath(db, boardPath(root), {
        since: instant,
        ...(options.leadAgent === undefined ? {} : { leadAgent: options.leadAgent }),
      }),
    ];
    const written = recordWasteRows(db, candidates);
    return {
      root,
      written,
      byKind: wasteByKind(db),
      totals: wasteTotals(db),
    };
  } finally {
    closeLedger(db);
  }
}

export type LedgerScanRevertsReport = {
  root: string;
  since: string;
  /** The signals this run found. */
  found: number;
  /** The signals this run wrote. */
  written: number;
  tokens: number;
};

/**
 * The reverted code of the repository, found on demand (§6.4).
 *
 * A command and not a daemon: it walks the history of the repository once,
 * when a person or the Lead asks for it. The tokens of a signal are the
 * builder tokens of the task the commit named, times the share of the lines
 * that were taken back.
 */
export async function runLedgerScanReverts(
  root: string,
  options: { since?: string | undefined } = {},
): Promise<LedgerScanRevertsReport> {
  const since = options.since ?? '30 days ago';
  const db = openLedger(root);
  try {
    const candidates = scanReverts(root, since, { tokensForTask: builderTokens(db) });
    const written = recordWasteRows(db, candidates);
    return {
      root,
      since,
      found: candidates.length,
      written,
      tokens: candidates.reduce((sum, row) => sum + row.tokens, 0),
    };
  } finally {
    closeLedger(db);
  }
}

/**
 * The tokens the builders of a task spent.
 *
 * The ledger holds the tokens per message and the task each message was
 * made for, so the sum of the builder rows of a task is what its reverts
 * cost.
 */
function builderTokens(db: ReturnType<typeof openLedger>): (taskId: string) => number {
  const rows = db
    .query(
      `SELECT task_id, SUM(input + output + reasoning + cache_write) AS tokens
       FROM usage WHERE task_id IS NOT NULL AND role = 'builder' GROUP BY task_id`,
    )
    .all() as { task_id: string; tokens: number }[];
  const map = new Map<string, number>();
  for (const row of rows) map.set(row.task_id, Number(row.tokens ?? 0));
  return (taskId: string) => map.get(taskId) ?? 0;
}

export type LedgerOutcomesReport = {
  root: string;
  since: string;
  found: number;
  written: number;
  byKind: { kind: string; count: number }[];
  /** Whether the task transitions were scanned. */
  taskTransitions: boolean;
};

/**
 * The outcomes of the work (§6.5).
 *
 * Two scanners run here: the `Refs:` trailers of the commits, and the task
 * transitions — but only when the caller injects a reader for the tasks
 * store. The ledger does not import that store, so the command runs without
 * the task transitions until whoever knows the store injects a reader.
 */
export async function runLedgerOutcomes(
  root: string,
  options: { since?: string | undefined; taskReader?: TaskReader | undefined } = {},
): Promise<LedgerOutcomesReport> {
  const since = options.since ?? '30 days ago';
  const db = openLedger(root);
  try {
    const candidates = [
      ...scanRefsTrailers(root, since),
      ...(options.taskReader === undefined
        ? []
        : await scanTaskTransitions(root, instantOf(since), options.taskReader)),
    ];
    let written = 0;
    for (const candidate of candidates) {
      if (recordOutcome(db, candidate)) written += 1;
    }
    const rows = db
      .query('SELECT kind, COUNT(*) AS count FROM outcome GROUP BY kind ORDER BY kind')
      .all() as { kind: string; count: number }[];
    return {
      root,
      since,
      found: candidates.length,
      written,
      taskTransitions: options.taskReader !== undefined,
      byKind: rows.map((row) => ({ kind: String(row.kind), count: Number(row.count) })),
    };
  } finally {
    closeLedger(db);
  }
}

/** The length of a unit the relative form of `--since` uses. */
const RELATIVE_UNITS: Record<string, number> = {
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_592_000_000,
};

/**
 * The instant a `--since` names, and the empty string when it names none.
 *
 * A date is a moment, and a relative phrase like "30 days ago" is a moment
 * too — git understands the phrase, and the scanners that compare
 * timestamps need it as a timestamp.
 */
function instantOf(since: string): string {
  const parsed = Date.parse(since);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  const relative = /^(\d+)\s+([a-z]+)\s+ago$/.exec(since);
  const amount = Number(relative?.[1]);
  const unit = relative?.[2];
  const ms = unit === undefined ? undefined : RELATIVE_UNITS[unit];
  if (ms === undefined || !Number.isFinite(amount)) return '';
  return new Date(Date.now() - amount * ms).toISOString();
}

/** The waste report, as a person reads it. */
export function formatWasteReport(report: LedgerWasteReport): string {
  const lines: string[] = [];
  lines.push('waste');
  lines.push(field('written', `${report.written} new signal(s)`));
  lines.push(
    field('tokens', `${tokens(report.totals.tokens)} (${report.totals.percentage.toFixed(1)}%)`),
  );
  lines.push('');
  if (report.byKind.length === 0) {
    lines.push('  (none)');
  }
  for (const kind of report.byKind) {
    lines.push(
      `  ${kind.kind.padEnd(16)}${tokens(kind.tokens).padStart(10)}  ${kind.count} signal(s)  ${kind.percentage.toFixed(1)}%`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** The head of a scan report: its title and the fields every scan has. */
function scanHead(title: string, fields: [string, string][]): string[] {
  const lines: string[] = [title];
  for (const [label, value] of fields) lines.push(field(label, value));
  return lines;
}

/** The revert report, as a person reads it. */
export function formatScanRevertsReport(report: LedgerScanRevertsReport): string {
  const lines = scanHead('scan-reverts', [
    ['since', report.since],
    ['found', `${report.found} commit(s)`],
    ['written', `${report.written} signal(s)`],
    ['tokens', tokens(report.tokens)],
  ]);
  return `${lines.join('\n')}\n`;
}

/** The outcome report, as a person reads it. */
export function formatOutcomesReport(report: LedgerOutcomesReport): string {
  const lines = scanHead('outcomes', [
    ['since', report.since],
    ['found', `${report.found} outcome(s)`],
    ['written', `${report.written} outcome(s)`],
    [
      'tasks',
      report.taskTransitions
        ? 'task transitions scanned'
        : 'task transitions not scanned (no reader injected)',
    ],
  ]);
  lines.push('');
  if (report.byKind.length === 0) {
    lines.push('  (none)');
  }
  for (const kind of report.byKind) {
    lines.push(`  ${kind.kind.padEnd(16)}${kind.count}`);
  }
  return `${lines.join('\n')}\n`;
}
