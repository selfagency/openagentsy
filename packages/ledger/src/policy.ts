import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import type { PolicyFiring, PolicyFiringSink } from '@openagentsy/core';
import { withBusyRetry } from './db.js';

/**
 * The policy firing log (§21.3).
 *
 * Every policy that was asked for a decision leaves a row here: the policy
 * id, the version it carried at that moment, the session it happened in and
 * what it decided. The version is the point of the row — a regression is
 * attributed to the version that caused it and not to the policy in general.
 *
 * The table is the ledger's, and the rows go into the ledger's database file,
 * so the log survives a restart: it is a store and not a memory.
 */

const INSERT = `INSERT INTO policy_firing
  (id, session_id, policy_id, policy_version, layer, action, severity, reason,
   finding_id, classification, detail, origin, ts)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`;

/**
 * Record one policy firing.
 *
 * The row is written once and is not deduplicated: a policy that fires twice
 * in a session fired twice, and the count of the firings is what the report
 * ranks the policies by.
 */
export function recordPolicyFiring(db: Database, firing: PolicyFiring): void {
  const ts = firing.ts ?? new Date().toISOString();
  withBusyRetry(() => {
    db.query(INSERT).run(
      randomUUID(),
      firing.sessionId,
      firing.policyId,
      firing.policyVersion,
      firing.layer,
      firing.action,
      firing.severity ?? null,
      firing.reason ?? null,
      firing.findingId ?? null,
      firing.classification ?? null,
      firing.detail ?? null,
      firing.origin ?? 'first-party',
      ts,
    );
  });
}

/**
 * A sink that writes the firings into a ledger.
 *
 * The engine writes through the interface and knows nothing of SQLite, so
 * the store the rows go into is the caller's choice.
 */
export function createPolicyFiringSink(db: Database): PolicyFiringSink {
  return {
    record: (firing: PolicyFiring) => {
      recordPolicyFiring(db, firing);
    },
  };
}

/** How often one policy was asked, and what it decided. */
export type PolicyFireCount = {
  /** The stable id of the policy. */
  policyId: string;
  /** How many times the policy was asked. */
  count: number;
  /** How many of those times it blocked. */
  blocks: number;
  /** How many of those times it flagged. */
  flags: number;
  /** The versions the policy carried, newest last. */
  versions: string[];
};

/**
 * The firing count of every policy the log holds a row for.
 *
 * The count is of every evaluation, and the block and flag counts are of the
 * evaluations that acted, so a reader can see a policy that was asked often
 * and never acted and one that acted every time.
 */
export function policyFireCounts(db: Database): PolicyFireCount[] {
  const rows = db
    .query(
      `SELECT
         policy_id AS policyId,
         COUNT(*) AS count,
         SUM(CASE WHEN action = 'block' THEN 1 ELSE 0 END) AS blocks,
         SUM(CASE WHEN action = 'flag' THEN 1 ELSE 0 END) AS flags
       FROM policy_firing
       GROUP BY policy_id
       ORDER BY count DESC, policy_id ASC`,
    )
    .all() as { policyId: string; count: number; blocks: number; flags: number }[];

  return rows.map((row) => ({
    policyId: row.policyId,
    count: row.count,
    blocks: row.blocks,
    flags: row.flags,
    versions: policyVersions(db, row.policyId),
  }));
}

/**
 * The versions one policy carried, in the order they were seen.
 *
 * A policy that carried two versions was changed between the two firings,
 * and the log is where that is visible.
 */
function policyVersions(db: Database, policyId: string): string[] {
  const rows = db
    .query(
      `SELECT DISTINCT policy_version AS version
       FROM policy_firing
       WHERE policy_id = ?
       ORDER BY policy_version ASC`,
    )
    .all(policyId) as { version: string | null }[];
  return rows.map((row) => row.version ?? 'unknown');
}

/**
 * The policies with the most firings, the largest first.
 *
 * The report asks for the ten of them; the number is a limit and not a
 * promise, because a log with fewer policies has fewer to show.
 */
export function topPoliciesByFireCount(db: Database, limit = 10): PolicyFireCount[] {
  return policyFireCounts(db).slice(0, Math.max(0, limit));
}

/** How many firings the log holds in all. */
export function policyFiringTotal(db: Database): number {
  const row = db.query('SELECT COUNT(*) AS total FROM policy_firing').get() as {
    total: number;
  } | null;
  return row?.total ?? 0;
}
