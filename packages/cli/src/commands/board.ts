import { access } from 'node:fs/promises';
import { join } from 'node:path';
import {
  closeDatabase,
  listBudgets,
  listLeases,
  listRecords,
  openDatabase,
} from '@openagentsy/core';

/**
 * The board, as a person reads it.
 *
 * The plan asks for a read-only view so a human can follow a run along:
 * the records the agents left, the leases they hold, and the budgets they
 * spend. It is a command and not a web page, because the thing it has to
 * do is show what happened, and a page is a server to keep alive.
 */

export type BoardView = {
  records: { id: number; kind: string; from: string; bean: string; action: string }[];
  leases: { bean: string; agent: string; glob: string }[];
  budgets: { bean: string; tokenLimit: number; stopAt: number }[];
};

export async function runBoard(root: string): Promise<BoardView> {
  const databasePath = join(root, '.openagentsy', 'board.sqlite');
  // A project that has no board yet has nothing to show, and reading it
  // should not create one.
  const exists = await access(databasePath).then(
    () => true,
    () => false,
  );
  if (!exists) return { records: [], leases: [], budgets: [] };

  const db = openDatabase(databasePath);
  try {
    const inbox = listRecords(db, { limit: 50 });
    return {
      records: inbox.records.map((record) => ({
        id: record.id,
        kind: record.kind,
        from: record.from,
        bean: record.bean,
        action: record.action,
      })),
      leases: listLeases(db).map((lease) => ({
        bean: lease.bean,
        agent: lease.agent,
        glob: lease.glob,
      })),
      budgets: listBudgets(db).map((budget) => ({
        bean: budget.bean,
        tokenLimit: budget.tokenLimit,
        stopAt: budget.stopAt,
      })),
    };
  } finally {
    closeDatabase(db);
  }
}

export function formatBoard(view: BoardView): string {
  const lines: string[] = [];

  lines.push('records');
  if (view.records.length === 0) {
    lines.push('  (none)');
  }
  for (const record of view.records) {
    lines.push(
      `  ${String(record.id).padStart(4)}  ${record.kind.padEnd(9)} ${record.from.padEnd(12)} ${record.bean.padEnd(14)} ${record.action}`,
    );
  }

  lines.push('');
  lines.push('leases');
  if (view.leases.length === 0) {
    lines.push('  (none)');
  }
  for (const lease of view.leases) {
    lines.push(`  ${lease.agent.padEnd(14)} ${lease.glob.padEnd(30)} ${lease.bean}`);
  }

  lines.push('');
  lines.push('budgets');
  if (view.budgets.length === 0) {
    lines.push('  (none)');
  }
  for (const budget of view.budgets) {
    lines.push(
      `  ${budget.bean.padEnd(20)} ${budget.tokenLimit} tokens, stops at ${budget.stopAt}`,
    );
  }

  return lines.join('\n');
}
