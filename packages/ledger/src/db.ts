import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { applySchema } from './schema.js';

/**
 * The ledger's database wiring.
 *
 * bun:sqlite is the driver because the OpenCode plugin runtime is Bun: the
 * adapter and the CLI read the same file the board writes, and a driver one
 * runtime lacks breaks the other.
 */

/** The state directory the ledger lives in (§6.1). */
export const STATE_DIR = '.openagentsy';
/** The database file, inside the state directory. */
export const LEDGER_FILE = 'ledger.db';
/** How long SQLite waits for a lock before it reports the database busy. */
export const BUSY_TIMEOUT_MS = 250;
/** How many times a busy write is retried (REV3 §6.1). */
export const BUSY_RETRIES = 5;
/** The first backoff, doubled per attempt, capped at the last one. */
export const BUSY_BACKOFF_MS = 1;
export const BUSY_BACKOFF_MAX_MS = 64;

/** The path of the ledger at a root. */
export function ledgerPath(root: string): string {
  return join(root, STATE_DIR, LEDGER_FILE);
}

/**
 * Open the ledger at a root.
 *
 * The root is injected: the state root of §3.9 is resolved by the caller,
 * so a worktree and its main repository share one ledger, and a test can
 * point at a temporary directory.
 */
export function openLedger(root: string): Database {
  const path = ledgerPath(root);
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  // WAL so a reader never blocks the writer, a short busy timeout so a
  // blocked write fails fast, and a retry on top of that (REV3 §6.1).
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  applySchema(db);
  return db;
}

/** Close the ledger. */
export function closeLedger(db: Database): void {
  db.close();
}

/** The flag the retry loop waits on. A shared buffer, so the wait is a wait. */
const WAKE = new Int32Array(new SharedArrayBuffer(4));

/**
 * Sleep without spinning the CPU.
 *
 * `Atomics.wait` parks the thread until the timeout, which is what a backoff
 * wants: the alternative is a loop that burns a core to wait for a lock.
 */
function sleepSync(ms: number): void {
  Atomics.wait(WAKE, 0, 0, ms);
}

/** Whether an error is the busy one. */
export function isBusyError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && code.startsWith('SQLITE_BUSY')) return true;
  const message =
    error instanceof Error ? error.message : String((error as { message?: unknown }).message ?? '');
  return message.includes('SQLITE_BUSY') || message.includes('database is locked');
}

/**
 * Run a write, and try again while the database is busy.
 *
 * SQLite reports a locked database as SQLITE_BUSY; the worktree case is the
 * common one, where a builder in a worktree and the Lead in the main
 * repository write the same file. The retry is bounded: five attempts, with
 * the wait doubling from a millisecond to a cap of sixty-four, so a write
 * never hangs and a locked database is reported rather than waited out.
 */
export function withBusyRetry<T>(operation: () => T, retries = BUSY_RETRIES): T {
  let attempt = 0;
  let delay = BUSY_BACKOFF_MS;
  for (;;) {
    try {
      return operation();
    } catch (error) {
      if (!isBusyError(error) || attempt >= retries) throw error;
      attempt += 1;
      sleepSync(delay);
      delay = Math.min(delay * 2, BUSY_BACKOFF_MAX_MS);
    }
  }
}
