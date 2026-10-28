import { Database } from 'bun:sqlite';
import type { UsageReaders } from '@openagentsy/core';
import { ledgerPath, perTaskTotals } from '@openagentsy/ledger';

/**
 * The usage the ledger holds for one bean (§6.7).
 *
 * The ledger is the measurement: the tokens are counted per message and
 * summed by the task the message belongs to, and the board's bean id is that
 * task id. The board asks this module what a bean spent, and the ledger
 * answers.
 */
type BeanUsage = {
  /** The tokens of every message the bean produced. */
  total: number;
  /** The tokens of the most expensive single turn. */
  turn: number;
  /** The tokens of the most expensive single session. */
  session: number;
};

/**
 * The tokens of a message.
 *
 * The same sum the ledger uses: the input, the output, the reasoning and the
 * cache writes. The cache reads are left out, because they were paid for
 * when they were written.
 */
const TOKENS = '(input + output + reasoning + cache_write)';

/** A number, or zero. A token count is never a guess. */
function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Read the ledger, read-only.
 *
 * The board never writes to the ledger: the ledger is the ledger's file, and
 * the plugin is the one that feeds it. A ledger that is not there yet, or a
 * file that cannot be read, answers with nothing, and the check falls back to
 * what the board already holds.
 */
function readLedger<T>(root: string, read: (db: Database) => T): T | undefined {
  let db: Database;
  try {
    db = new Database(ledgerPath(root), { readonly: true });
  } catch {
    return undefined;
  }
  try {
    return read(db);
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

/** The tokens of the most expensive single message of a bean. */
function largestTurn(db: Database, bean: string): number {
  const row = db
    .query(`SELECT MAX(${TOKENS}) AS tokens FROM usage WHERE task_id = ?`)
    .get(bean) as { tokens?: unknown } | null;
  return number(row?.tokens);
}

/**
 * The tokens of the most expensive single session of a bean.
 *
 * A session is a group of messages under one session id, and the cap is on
 * the session: the most expensive one of the bean's sessions is the one that
 * has to fit.
 */
function largestSession(db: Database, bean: string): number {
  const row = db
    .query(
      `SELECT MAX(total) AS tokens FROM (
        SELECT session_id, SUM(${TOKENS}) AS total FROM usage WHERE task_id = ? GROUP BY session_id
      )`,
    )
    .get(bean) as { tokens?: unknown } | null;
  return number(row?.tokens);
}

/**
 * What the ledger holds for a bean.
 *
 * A bean the ledger knows nothing about answers with nothing: the check
 * falls back to the board's own number rather than reporting zero usage for
 * a bean that has messages.
 */
function ledgerUsage(root: string, bean: string): BeanUsage | undefined {
  return readLedger(root, (db) => {
    const totals = perTaskTotals(db);
    const row = totals.find((entry) => entry.taskId === bean);
    if (row === undefined) return undefined;
    return {
      total: row.tokens,
      turn: largestTurn(db, bean),
      session: largestSession(db, bean),
    };
  });
}

/**
 * The readers the budget check asks.
 *
 * Each reading opens the ledger on its own: a budget check is rare, and a
 * reader that holds the file open across the whole life of the board would
 * be a handle nobody closes.
 */
export function ledgerReaders(root: string): UsageReaders {
  return {
    total: (bean) => ledgerUsage(root, bean)?.total,
    turn: (bean) => ledgerUsage(root, bean)?.turn,
    session: (bean) => ledgerUsage(root, bean)?.session,
  };
}
