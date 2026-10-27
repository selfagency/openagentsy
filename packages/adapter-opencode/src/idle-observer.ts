import { isRoundStatus, type RoundStatus } from '@openagentsy/core';
import { detectNoProgressAtPath, recordWasteRows } from '@openagentsy/ledger';

/**
 * The observer on `session.idle` (§8.7).
 *
 * The Lead's round is READ → RECOVER → DECIDE → PERSIST → REPORT, and the
 * report speaks only after PERSIST has written the state. So the report and
 * the board have to agree, and this module is where they are compared.
 *
 * The `event` hook is not awaited (§8.2), so a mismatch can only be
 * flagged: the session is never held up by it, and the flag goes to the
 * Accountability block instead.
 *
 * The module is pure. It reads the board through the core's board API and
 * takes the board's reader as an argument, so a test can hand it a status
 * without a database, and it never opens a database itself.
 */

/** A finding: the report and the board disagree. */
export type RoundStatusFinding = {
  /** The session whose last report was checked. */
  sessionId: string;
  /** The status the report claimed. */
  claimed: string;
  /** The status the board holds. */
  boardStatus: RoundStatus;
  /** The line the Accountability block shows. */
  detail: string;
};

/**
 * Compare the status the report claims with the status the board holds.
 *
 * There is no finding when the board holds no status: that is a round that
 * has not been persisted yet, so there is nothing to contradict. There is no
 * finding when the report claims no status either, for the same reason.
 */
export function observeRoundStatus(
  claimed: string | undefined,
  boardStatus: RoundStatus | undefined,
  sessionId: string,
): RoundStatusFinding | undefined {
  if (boardStatus === undefined) return undefined;
  if (claimed === undefined) return undefined;
  if (claimed === boardStatus) return undefined;
  return {
    sessionId,
    claimed,
    boardStatus,
    detail: `the report claims "${claimed}" but the board says "${boardStatus}"`,
  };
}

/** The board's reader: the round status the board holds, or nothing. */
export type RoundStatusReader = () => RoundStatus | undefined;

/**
 * The same comparison, with the board's reader as the argument.
 *
 * The wiring calls this with the reader it already has, so the observer
 * never learns where the board lives.
 */
export function observeSessionIdle(
  claimed: string | undefined,
  reader: RoundStatusReader,
  sessionId: string,
): RoundStatusFinding | undefined {
  return observeRoundStatus(claimed, reader(), sessionId);
}

/**
 * The status a message claims, when it claims one.
 *
 * The claim is a status behind a label, and the labels are the ones a Lead
 * report uses: `status: complete`, `the round status is complete`,
 * `state: complete`, `the round is complete`. The last claim in the message
 * wins: the report is the end of the round, not its beginning.
 */
export function claimedStatusOf(text: string): string | undefined {
  const pattern = /\b(?:round\s+status|status|state|round)\b\s*(?:is|was|:|=)\s*["']?([a-z_]+)/gi;
  let found: string | undefined;
  for (const match of text.matchAll(pattern)) {
    const token = (match[1] ?? '').toLowerCase();
    if (isRoundStatus(token)) found = token;
  }
  return found;
}

/** What the no-progress detector needs to know. */
export type NoProgressOptions = {
  /** The agent the Lead writes its records under. */
  leadAgent?: string | undefined;
  /** The role key the Lead's usage rows carry. */
  leadRole?: string | undefined;
};

/**
 * Write the waste events of the Lead's rounds that went nowhere (§6.4).
 *
 * The decision is the ledger's own, not a second one: the same predicate,
 * the same detail and the same dedup key, so a round the observer and
 * `oa ledger` both see is written once and counted once. The tokens counted
 * are the round's own.
 */
export function recordNoProgressRounds(
  db: Parameters<typeof recordWasteRows>[0],
  boardPath: string,
  options: NoProgressOptions = {},
): number {
  const candidates = detectNoProgressAtPath(db, boardPath, {
    ...(options.leadAgent === undefined ? {} : { leadAgent: options.leadAgent }),
    ...(options.leadRole === undefined ? {} : { leadRole: options.leadRole }),
  });
  return recordWasteRows(db, candidates);
}
