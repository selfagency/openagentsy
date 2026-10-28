import { join } from 'node:path';
import {
  appendAudit,
  type BoardDatabase,
  closeDatabase,
  listRecords,
  openDatabase,
  setRecordState,
} from '@openagentsy/core';
import {
  type BoardRecord,
  type DecideOutcome,
  type MemoryAuditSink,
  MemoryInbox,
  MemoryStore,
} from '@openagentsy/memory';
import type { Plugin } from '@opencode/plugin/tui';
import type { MemoryView } from '../readers.js';

/**
 * The keys of the memory inbox (§7.4).
 *
 * The candidates are the board's pending `bean: memory` records, and the
 * decision on one is a person's (§4.3): `a` approves the first candidate
 * that waits and `r` rejects it.
 *
 * The layer is registered without a mode. The host gives a layer the base
 * mode when it names none, and the base mode is not the prompt's, so the
 * keys do not fire while the prompt has the focus.
 */

/** The decision a key makes. */
export type MemoryDecision = 'approve' | 'reject';

/** The id of the command that approves a candidate. */
export const APPROVE_COMMAND = 'memory.approve';

/** The id of the command that rejects a candidate. */
export const REJECT_COMMAND = 'memory.reject';

/** What the keymap needs to decide. */
export interface MemoryInboxKeys {
  /** The context the layer is registered with. */
  readonly context: Plugin.Context;
  /** The candidates that wait for a decision, read when the layer is built. */
  readonly view: () => MemoryView;
  /** The decision, made in the human-only path (§4.3). */
  readonly decide: (recordId: number, decision: MemoryDecision) => Promise<DecideOutcome>;
}

/**
 * The keymap layer of the memory inbox.
 *
 * The layer is disabled while no candidate waits: a key that decides on
 * nothing is a key that does nothing.
 */
export function memoryInboxKeymap(keys: MemoryInboxKeys): void {
  const { context, view, decide } = keys;
  context.keymap.layer(() => ({
    enabled: () => view().candidates.length > 0,
    commands: [
      {
        id: APPROVE_COMMAND,
        title: 'Approve the memory candidate',
        bind: 'a',
        run: () => decideFirst(view, decide, 'approve'),
      },
      {
        id: REJECT_COMMAND,
        title: 'Reject the memory candidate',
        bind: 'r',
        run: () => decideFirst(view, decide, 'reject'),
      },
    ],
  }));
}

/**
 * The decision a key makes, on the first candidate that waits.
 *
 * A decision that did not go through is not swallowed: the reason is thrown,
 * because a candidate that was neither approved nor rejected is a candidate
 * the block still shows.
 */
async function decideFirst(
  view: () => MemoryView,
  decide: (recordId: number, decision: MemoryDecision) => Promise<DecideOutcome>,
  decision: MemoryDecision,
): Promise<void> {
  const id = view().candidates[0]?.id;
  if (id === undefined) return;
  const outcome = await decide(id, decision);
  if (!outcome.ok) throw new Error(outcome.detail);
}

/** How many records one page of the board holds. */
const PAGE_SIZE = 100;

/** The path of the board's database under a state root. */
function boardPath(stateRoot: string): string {
  return join(stateRoot, '.openagentsy', 'board.sqlite');
}

/** The path of the audit log under a state root. */
function auditPath(stateRoot: string): string {
  return join(stateRoot, '.openagentsy', 'audit.jsonl');
}

/**
 * Every record on the board, in order.
 *
 * The inbox reads the board's records, and the board holds more than one
 * page of them, so the pages are walked until one comes back short.
 */
function everyRecord(db: BoardDatabase): BoardRecord[] {
  const found: BoardRecord[] = [];
  let cursor = 0;
  for (;;) {
    const page = listRecords(db, { cursor, limit: PAGE_SIZE });
    found.push(...page.records);
    if (page.records.length < PAGE_SIZE) return found;
    cursor = page.nextCursor;
  }
}

/**
 * The audit sink of a memory decision.
 *
 * The decision is a person's, so the audit line says who made it, and the
 * policy id is the one the plan names (§4.3).
 */
function auditSink(stateRoot: string): MemoryAuditSink {
  return async (policyId, detail) => {
    await appendAudit(auditPath(stateRoot), {
      policyId,
      policyVersion: 'v1',
      actor: detail.decidedBy,
      action: detail.decision ?? 'forget',
      resource:
        detail.recordId === undefined ? `memory:${detail.id ?? ''}` : `record:${detail.recordId}`,
      effect: 'allow',
      detail: JSON.stringify(detail),
    });
  };
}

/**
 * The decision a person makes on a memory candidate (§4.3).
 *
 * The decision is made in the memory package's inbox: an approval appends
 * the candidate to `memory.jsonl` and marks the record `promoted`, a
 * rejection marks the record `rejected` and the text never reaches the
 * store. The state is written back to the board, and the decision is
 * audited.
 *
 * The board is opened for the decision and closed after it, so a session
 * that never decides holds no database open.
 */
export function memoryDecider(
  stateRoot: string,
): (recordId: number, decision: MemoryDecision) => Promise<DecideOutcome> {
  return async (recordId, decision) => {
    const db = openDatabase(boardPath(stateRoot));
    try {
      const audit = auditSink(stateRoot);
      const store = new MemoryStore({ root: stateRoot, onAudit: audit });
      const inbox = new MemoryInbox({
        root: stateRoot,
        store,
        read: async () => everyRecord(db),
        markState: async (id, state) => {
          setRecordState(db, id, state);
        },
        onAudit: audit,
      });
      return await inbox.decide(recordId, decision, deciderBy());
    } finally {
      closeDatabase(db);
    }
  };
}

/** Who the person in front of the screen is. */
function deciderBy(): string {
  return process.env['OPENAGENTSY_USER'] ?? 'human';
}
