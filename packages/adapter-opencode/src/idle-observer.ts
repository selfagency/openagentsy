import {
  type BoardDatabase,
  isRoundStatus,
  listLeases,
  listRecords,
  type RoundStatus,
} from '@openagentsy/core';
import { recordWasteRows } from '@openagentsy/ledger';

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
 * The claim is a status token behind a label, so a sentence that mentions a
 * status without claiming it does not count. The last claim in the message
 * wins: the report is the end of the round, not its beginning.
 */
export function claimedStatusOf(text: string): string | undefined {
  const pattern = /(?:round\s+)?status\s*[:=]\s*([a-z_]+)|round\s*[:=]\s*([a-z_]+)/gi;
  let found: string | undefined;
  for (const match of text.matchAll(pattern)) {
    const token = (match[1] ?? match[2] ?? '').toLowerCase();
    if (isRoundStatus(token)) found = token;
  }
  return found;
}

/** What a round of the Lead's loop did. */
export type RoundFacts = {
  /** The dispatches the round made. */
  dispatched: number;
  /** The results the round consumed. */
  consumed: number;
  /** Whether the board changed under the round. */
  changed: boolean;
};

/**
 * Whether the round changed nothing at all (§8.7).
 *
 * A round that dispatched nothing, consumed no result and changed nothing on
 * the board cannot claim progress. The Lead's own record does not count: it
 * is the PERSIST stage writing the round down, not the round moving.
 */
export function roundChangedNothing(facts: RoundFacts): boolean {
  return facts.dispatched === 0 && facts.consumed === 0 && !facts.changed;
}

/** The window of a round, and the agent that ran it. */
export type RoundWindow = {
  /** The agent that ran the round. */
  agent: string;
  /** When the round started. */
  from: string;
  /** When the round ended. */
  until: string;
};

/** How many records one page of the board holds. */
const PAGE = 100;

/**
 * The records of a window, read through the board's own API.
 *
 * The board is read page by page, because the window is a slice of the
 * whole and the newest records are the last ones. The read never marks
 * anything read: the observer is a witness, not a reader of the inbox.
 */
function recordsInWindow(db: BoardDatabase, window: RoundWindow) {
  const inside: ReturnType<typeof listRecords>['records'] = [];
  let cursor = 0;
  for (;;) {
    const page = listRecords(db, { cursor, limit: PAGE, markRead: false });
    for (const record of page.records) {
      if (record.createdAt > window.from && record.createdAt <= window.until) {
        inside.push(record);
      }
    }
    if (page.records.length < PAGE) break;
    cursor = page.nextCursor;
  }
  return inside;
}

/**
 * What a round did, read from the board.
 *
 * A dispatch is a record the Lead addressed to somebody else, a consumed
 * result is a record addressed to the Lead, and the board changed when
 * somebody else wrote or when a lease was taken. These are the same three
 * things the ledger's own no-progress detector counts (§6.4).
 */
export function readRoundFacts(db: BoardDatabase, window: RoundWindow): RoundFacts {
  const inside = recordsInWindow(db, window);
  const dispatched = inside.filter(
    (record) => record.from === window.agent && record.to !== undefined,
  ).length;
  const consumed = inside.filter((record) => record.to === window.agent).length;
  const changed =
    inside.some((record) => record.from !== window.agent) ||
    listLeases(db).some(
      (lease) => lease.grantedAt > window.from && lease.grantedAt <= window.until,
    );
  return { dispatched, consumed, changed };
}

/** The round that ended, and what it cost. */
export type RoundWaste = {
  /** The tokens the round cost. */
  tokens: number;
  /** When the round ended. */
  ts: string;
  /** The session the round belongs to. */
  rootSessionId?: string | undefined;
  /** The message the round ended on. */
  messageId?: string | undefined;
};

/**
 * Write the waste event of a round that changed nothing.
 *
 * The kind is `no_progress` and the tokens are the round's own, so the
 * waste of a round that went nowhere is measured like any other waste. A
 * round that changed something writes nothing at all.
 */
export function recordNoProgressRound(
  db: Parameters<typeof recordWasteRows>[0],
  facts: RoundFacts,
  round: RoundWaste,
): boolean {
  if (!roundChangedNothing(facts)) return false;
  const written = recordWasteRows(db, [
    {
      kind: 'no_progress',
      tokens: round.tokens,
      ts: round.ts,
      ...(round.rootSessionId === undefined ? {} : { rootSessionId: round.rootSessionId }),
      ...(round.messageId === undefined ? {} : { messageId: round.messageId }),
      detail: 'lead round with no dispatch, no result and no board change',
    },
  ]);
  return written > 0;
}
