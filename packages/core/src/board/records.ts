import type { DatabaseSync } from 'node:sqlite';
import {
  type BoardRecord,
  CONFIDENCE_LEVELS,
  type Confidence,
  type PostRecordInput,
  RECORD_KINDS,
  type RecordKind,
} from './types.js';

export class BoardError extends Error {
  readonly hint: string;

  constructor(message: string, hint: string) {
    super(message);
    this.name = 'BoardError';
    this.hint = hint;
  }
}

type RecordRow = {
  id: number;
  bean: string;
  kind: string;
  from_agent: string;
  to_agent: string | null;
  action: string;
  state: string;
  artifact: string | null;
  contract: string | null;
  needs: string | null;
  surprise: string | null;
  confidence: string;
  created_at: string;
};

function toRecord(row: RecordRow, read: boolean): BoardRecord {
  const record: BoardRecord = {
    id: row.id,
    bean: row.bean,
    kind: row.kind as RecordKind,
    from: row.from_agent,
    action: row.action,
    state: row.state,
    confidence: row.confidence as Confidence,
    read,
    createdAt: row.created_at,
  };
  if (row.to_agent !== null) record.to = row.to_agent;
  if (row.artifact !== null) record.artifact = row.artifact;
  if (row.contract !== null) record.contract = JSON.parse(row.contract) as unknown;
  if (row.needs !== null) record.needs = row.needs;
  if (row.surprise !== null) record.surprise = row.surprise;
  return record;
}

export function createRecord(db: DatabaseSync, input: PostRecordInput): BoardRecord {
  const empty = (['bean', 'from', 'action', 'state'] as const).find(
    (field) => input[field].trim().length === 0,
  );
  if (empty) {
    throw new BoardError(
      `${empty} is required and cannot be empty`,
      'fill in bean, from, action and state, they are what the next agent reads',
    );
  }
  if (!RECORD_KINDS.includes(input.kind)) {
    throw new BoardError(
      `unknown record kind "${input.kind}"`,
      `use one of ${RECORD_KINDS.join(', ')}`,
    );
  }
  if (!CONFIDENCE_LEVELS.includes(input.confidence)) {
    throw new BoardError(
      `unknown confidence "${input.confidence}"`,
      `use one of ${CONFIDENCE_LEVELS.join(', ')}`,
    );
  }

  const createdAt = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO records
         (bean, kind, from_agent, to_agent, action, state, artifact, contract, needs, surprise, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.bean,
      input.kind,
      input.from,
      input.to ?? null,
      input.action,
      input.state,
      input.artifact ?? null,
      input.contract === undefined ? null : JSON.stringify(input.contract),
      input.needs ?? null,
      input.surprise ?? null,
      input.confidence,
      createdAt,
    );

  const id = Number(result.lastInsertRowid);
  return {
    id,
    bean: input.bean,
    kind: input.kind,
    from: input.from,
    action: input.action,
    state: input.state,
    confidence: input.confidence,
    read: false,
    createdAt,
    ...(input.to !== undefined ? { to: input.to } : {}),
    ...(input.artifact !== undefined ? { artifact: input.artifact } : {}),
    ...(input.contract !== undefined ? { contract: input.contract } : {}),
    ...(input.needs !== undefined ? { needs: input.needs } : {}),
    ...(input.surprise !== undefined ? { surprise: input.surprise } : {}),
  };
}

export type InboxQuery = {
  agent: string;
  cursor?: number;
  limit?: number;
  markRead?: boolean;
};

export type InboxResult = {
  records: BoardRecord[];
  nextCursor: number;
  unread: number;
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Read the records waiting for one agent, in one call.
 *
 * A record with no `to` is a broadcast and goes to every agent, so the Lead
 * sees the board without anyone having to address it. Read state is per
 * (record, agent), so one agent reading a broadcast does not clear it for
 * the others.
 */
export function listRecords(db: DatabaseSync, query: InboxQuery): InboxResult {
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const cursor = query.cursor ?? 0;

  const rows = db
    .prepare(
      `SELECT id, bean, kind, from_agent, to_agent, action, state, artifact, contract, needs, surprise, confidence, created_at
         FROM records
        WHERE id > ?
          AND (to_agent = ? OR to_agent IS NULL)
          AND NOT EXISTS (
            SELECT 1 FROM record_reads
             WHERE record_reads.record_id = records.id
               AND record_reads.agent = ?
          )
        ORDER BY id ASC
        LIMIT ?`,
    )
    .all(cursor, query.agent, query.agent, limit) as unknown as RecordRow[];

  const records = rows.map((row) => toRecord(row, false));

  const unreadRow = db
    .prepare(
      `SELECT COUNT(*) AS count
         FROM records
        WHERE (to_agent = ? OR to_agent IS NULL)
          AND NOT EXISTS (
            SELECT 1 FROM record_reads
             WHERE record_reads.record_id = records.id
               AND record_reads.agent = ?
          )`,
    )
    .get(query.agent, query.agent) as unknown as { count: number };

  if (query.markRead !== false && records.length > 0) {
    const mark = db.prepare(
      `INSERT OR IGNORE INTO record_reads (record_id, agent, read_at) VALUES (?, ?, ?)`,
    );
    const readAt = new Date().toISOString();
    for (const record of records) {
      mark.run(record.id, query.agent, readAt);
    }
  }

  const nextCursor = records.at(-1)?.id ?? cursor;

  return { records, nextCursor, unread: Number(unreadRow.count) };
}
