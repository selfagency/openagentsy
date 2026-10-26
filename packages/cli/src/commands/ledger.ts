import { access } from 'node:fs/promises';
import {
  closeLedger,
  emptyLedgerExport,
  type LedgerExport,
  ledgerExport,
  ledgerPath,
  openLedger,
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
