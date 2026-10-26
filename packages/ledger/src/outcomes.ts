import type { Database } from 'bun:sqlite';
import { withBusyRetry } from './db.js';
import { gitCommits, refsTrailers } from './git.js';
import { OUTCOME_KINDS, type OutcomeKind } from './schema.js';

/**
 * The outcomes of §6.5 — what the tokens of the work produced.
 *
 * Three sources fill the outcome table: the task transitions of the tasks
 * store, the `Refs:` trailers of the commits and the merges of the pull
 * requests. The first two are scanned here; the third is seen by the `pr`
 * integration mode.
 *
 * The two scanners that read another package's data take it through an
 * injected reader instead of importing it: the ledger holds no dependency on
 * the tasks store, and the caller that knows the store injects it.
 */

/** An outcome, ready to be written. */
export type OutcomeCandidate = {
  kind: OutcomeKind;
  ts: string;
  taskId?: string | undefined;
  commitSha?: string | undefined;
  rootSessionId?: string | undefined;
};

/** What a caller hands to `recordOutcome`. */
export type OutcomeInput = {
  kind: OutcomeKind;
  taskId?: string | undefined;
  commitSha?: string | undefined;
  rootSessionId?: string | undefined;
  /** The moment the outcome happened; the clock when it is not given. */
  ts?: string | undefined;
};

const OUTCOME_INSERT = `INSERT INTO outcome
  (root_session_id, task_id, commit_sha, kind, ts)
  VALUES (?,?,?,?,?)`;

/**
 * Record one outcome.
 *
 * The kind is checked against the four of §6.1 before the row is written, so
 * a mistake is a message and not a constraint violation. The write is
 * idempotent: an outcome that is already there — the same kind, the same
 * task and the same commit — is not written twice, because the scanners are
 * commands that run over the same history again and again.
 *
 * Returns whether a row was written.
 */
export function recordOutcome(db: Database, outcome: OutcomeInput): boolean {
  if (!(OUTCOME_KINDS as readonly string[]).includes(outcome.kind)) {
    throw new Error(`unknown outcome kind: ${outcome.kind}`);
  }
  if (outcomeExists(db, outcome)) return false;

  const ts = outcome.ts ?? new Date().toISOString();
  withBusyRetry(() => {
    db.query(OUTCOME_INSERT).run(
      outcome.rootSessionId ?? null,
      outcome.taskId ?? null,
      outcome.commitSha ?? null,
      outcome.kind,
      ts,
    );
  });
  return true;
}

/** Whether the ledger already holds this outcome. */
function outcomeExists(db: Database, outcome: OutcomeInput): boolean {
  const found = db
    .query(
      `SELECT 1 FROM outcome
       WHERE kind = ? AND task_id IS ? AND commit_sha IS ?
       LIMIT 1`,
    )
    .get(outcome.kind, outcome.taskId ?? null, outcome.commitSha ?? null);
  return found !== null;
}

/**
 * The outcomes of the commits that carry a `Refs:` trailer (§6.5).
 *
 * The trailer is what the pre-commit hook requires of an agent commit, so
 * the commits of the agents are the ones this finds. A commit without a
 * trailer names no task and becomes no outcome.
 */
export function scanRefsTrailers(gitDir: string, since: string): OutcomeCandidate[] {
  const candidates: OutcomeCandidate[] = [];
  for (const commit of gitCommits(gitDir, since)) {
    for (const taskId of refsTrailers(commit.message)) {
      candidates.push({
        kind: 'commit',
        taskId,
        commitSha: commit.sha,
        ts: new Date(commit.at * 1000).toISOString(),
      });
    }
  }
  return candidates;
}

/**
 * A task, as the transition scan needs to see it.
 *
 * The shape is the one the tasks store has, and only the three fields the
 * scan reads: the id, the status and the moment the task last changed.
 */
export type LedgerTask = {
  id: string;
  status: string;
  updated_at?: string | undefined;
};

/**
 * The reader of the tasks store.
 *
 * The ledger does not import the tasks package: the store is another
 * program's data, and the caller that knows where it lives injects a reader
 * for it. The reader is given the root it is to read and hands back the
 * tasks it found.
 */
export type TaskReader = (root: string) => Promise<LedgerTask[]>;

/**
 * The outcomes of the task transitions (§6.5).
 *
 * A task that reached `completed` or `scrapped` is an outcome. The moment of
 * the transition is the moment the task last changed; a task that carries no
 * timestamp is taken as it is now, because the store says its status and
 * the time of the change is not in it.
 */
export async function scanTaskTransitions(
  root: string,
  since: string,
  reader: TaskReader,
): Promise<OutcomeCandidate[]> {
  const tasks = await reader(root);
  const candidates: OutcomeCandidate[] = [];
  for (const task of tasks) {
    if (task.status !== 'completed' && task.status !== 'scrapped') continue;
    const ts = task.updated_at ?? new Date().toISOString();
    if (since.length > 0 && ts < since) continue;
    candidates.push({
      kind: task.status === 'completed' ? 'task_completed' : 'task_scrapped',
      taskId: task.id,
      ts,
    });
  }
  return candidates;
}
