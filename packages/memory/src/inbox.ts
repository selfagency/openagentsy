import {
  DEFAULT_CATEGORY,
  isMemoryConfidence,
  type MemoryConfidence,
  type MemoryEntry,
} from './model.js';
import type { MemoryAuditSink, MemoryStore } from './store.js';

/**
 * The inbox of candidate memories.
 *
 * The candidates are the board's records: the archivist posts them as
 * `bean: memory` findings, and a person decides on each one. The inbox is
 * not a second queue - it is the board's pending `bean: memory` records, so
 * there is nothing to drift between what the archivist posted and what the
 * inbox shows.
 */

/** The bean a candidate memory is posted under. */
export const MEMORY_BEAN = 'memory';

/** The states a decided candidate carries. */
export const DECIDED_STATES = ['promoted', 'rejected'] as const;

/** The state a decided candidate carries. */
export type DecisionState = (typeof DECIDED_STATES)[number];

/**
 * A board record, as the inbox reads it.
 *
 * The shape the board already has. The package never imports the board
 * server, so the reader is injected: the wiring that will register these
 * tools passes the real reader, and a test passes a fake one.
 */
export type BoardRecord = {
  id: number;
  bean: string;
  kind: string;
  from: string;
  to?: string;
  action: string;
  state: string;
  confidence: string;
  createdAt?: string;
};

/** The reader the inbox gets its candidates from. */
export type BoardReader = (root: string) => Promise<BoardRecord[]>;

export type MemoryInboxOptions = {
  /** The root the reader is given. */
  root: string;
  /** The reader. */
  read: BoardReader;
  /** The store an approved candidate is appended to. */
  store: MemoryStore;
  /** Where a decision is audited. */
  onAudit?: MemoryAuditSink;
  /**
   * How a decided candidate's state is written back to the board.
   *
   * The board's records are written through the board server, and this
   * package never imports it, so the write is injected like the read. When
   * it is absent the decision still updates the record the reader returned,
   * which is what a reader that holds its records in memory sees.
   */
  markState?: (recordId: number, state: DecisionState) => void | Promise<void>;
};

/** What a decision did. */
export type DecideOutcome =
  | {
      ok: true;
      decision: 'approve' | 'reject';
      recordId: number;
      state: DecisionState;
      redactions: number;
      entry?: MemoryEntry;
    }
  | {
      ok: false;
      reason: 'unknown-record' | 'not-a-candidate' | 'already-decided' | 'duplicate' | 'invalid';
      detail: string;
      recordId: number;
      redactions: number;
      id?: string;
    };

/** A candidate, read out of a board record. */
export type Candidate = {
  text: string;
  category: string;
  source: string;
  confidence: MemoryConfidence;
};

/**
 * The pending candidates.
 *
 * A candidate is a `bean: memory` record that no person has decided on yet.
 * A record that was promoted or rejected is not pending, whatever else it
 * says.
 */
export class MemoryInbox {
  private readonly root: string;
  private readonly read: BoardReader;
  private readonly store: MemoryStore;
  private readonly onAudit: MemoryAuditSink | undefined;
  private readonly markState:
    | ((recordId: number, state: DecisionState) => void | Promise<void>)
    | undefined;

  constructor(options: MemoryInboxOptions) {
    this.root = options.root;
    this.read = options.read;
    this.store = options.store;
    this.onAudit = options.onAudit;
    this.markState = options.markState;
  }

  /** The candidates no person has decided on yet. */
  async pending(): Promise<BoardRecord[]> {
    const records = await this.read(this.root);
    return records.filter((record) => isPending(record));
  }

  /**
   * Decide on a candidate.
   *
   * Approving redacts the text, appends it to the store and marks the
   * record promoted; rejecting marks the record rejected and the store never
   * sees the text. Either way the decision is audited.
   */
  async decide(
    recordId: number,
    decision: 'approve' | 'reject',
    decidedBy: string,
  ): Promise<DecideOutcome> {
    const records = await this.read(this.root);
    const record = records.find((candidate) => candidate.id === recordId);
    if (record === undefined) {
      return {
        ok: false,
        reason: 'unknown-record',
        detail: `no record carries the id ${recordId}`,
        recordId,
        redactions: 0,
      };
    }
    if (record.bean !== MEMORY_BEAN) {
      return {
        ok: false,
        reason: 'not-a-candidate',
        detail: `the record ${recordId} is not a memory candidate`,
        recordId,
        redactions: 0,
      };
    }
    if (!isPending(record)) {
      return {
        ok: false,
        reason: 'already-decided',
        detail: `the record ${recordId} was already decided`,
        recordId,
        redactions: 0,
      };
    }

    if (decision === 'reject') {
      await this.mark(record, 'rejected');
      await this.onAudit?.('oa.memory.decide', { recordId, decidedBy, decision });
      return { ok: true, decision, recordId, state: 'rejected', redactions: 0 };
    }

    const candidate = parseCandidate(record);
    const appended = await this.store.append({
      text: candidate.text,
      category: candidate.category,
      source: candidate.source,
      confidence: candidate.confidence,
    });
    if (!appended.ok) {
      return {
        ok: false,
        reason: appended.reason,
        detail: appended.reason === 'duplicate' ? 'the memory is already known' : appended.detail,
        recordId,
        redactions: appended.redactions,
        ...(appended.reason === 'duplicate' ? { id: appended.id } : {}),
      };
    }

    await this.mark(record, 'promoted');
    await this.onAudit?.('oa.memory.decide', { recordId, decidedBy, decision });
    return {
      ok: true,
      decision,
      recordId,
      state: 'promoted',
      redactions: appended.redactions,
      entry: appended.entry,
    };
  }

  /** Write the state back, both on the record and on the board. */
  private async mark(record: BoardRecord, state: DecisionState): Promise<void> {
    record.state = state;
    await this.markState?.(record.id, state);
  }
}

/** Whether a record is a candidate no person has decided on. */
export function isPending(record: BoardRecord): boolean {
  return record.bean === MEMORY_BEAN && !isDecided(record.state);
}

/** Whether a state says the candidate was decided. */
export function isDecided(state: string): boolean {
  return (DECIDED_STATES as readonly string[]).includes(state);
}

/**
 * The candidate a record carries.
 *
 * The archivist posts the candidate in the action, and its category and
 * source in the state, so the state is where the two are read from. The
 * source of the memory is the record the candidate came from, and what it
 * pointed at.
 */
export function parseCandidate(record: BoardRecord): Candidate {
  const { category, source } = parseCandidateState(record.state);
  return {
    text: record.action,
    category,
    source: `${record.id} · ${source}`,
    confidence: isMemoryConfidence(record.confidence) ? record.confidence : 'guess',
  };
}

/** The mark that separates a candidate's category from its source. */
const SEPARATOR = ' · ';

/**
 * The category and the source a pending record carries.
 *
 * The two are separated by the same mark the memory's own source uses, so a
 * state of `build · packages/core/src/x.ts:12` names the category `build`
 * and the source `packages/core/src/x.ts:12`.
 */
export function parseCandidateState(state: string): { category: string; source: string } {
  const separator = state.indexOf(SEPARATOR);
  if (separator === -1) {
    return { category: DEFAULT_CATEGORY, source: state.trim() };
  }
  const category = state.slice(0, separator).trim();
  return {
    category: category.length > 0 ? category : DEFAULT_CATEGORY,
    source: state.slice(separator + SEPARATOR.length).trim(),
  };
}
