import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type { BoardDatabase } from './db.js';
import { recordReads, records } from './schema.js';
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

type RecordRow = typeof records.$inferSelect;

function toRecord(row: RecordRow, read: boolean): BoardRecord {
  const record: BoardRecord = {
    id: row.id,
    bean: row.bean,
    kind: row.kind as RecordKind,
    from: row.fromAgent,
    action: row.action,
    state: row.state,
    confidence: row.confidence as Confidence,
    read,
    createdAt: row.createdAt,
  };
  if (row.toAgent !== null) record.to = row.toAgent;
  if (row.artifact !== null) record.artifact = row.artifact;
  if (row.contract !== null) record.contract = JSON.parse(row.contract) as unknown;
  if (row.needs !== null) record.needs = row.needs;
  if (row.surprise !== null) record.surprise = row.surprise;
  return record;
}

export function createRecord(db: BoardDatabase, input: PostRecordInput): BoardRecord {
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
  const inserted = db
    .insert(records)
    .values({
      bean: input.bean,
      kind: input.kind,
      fromAgent: input.from,
      toAgent: input.to ?? null,
      action: input.action,
      state: input.state,
      artifact: input.artifact ?? null,
      contract: input.contract === undefined ? null : JSON.stringify(input.contract),
      needs: input.needs ?? null,
      surprise: input.surprise ?? null,
      confidence: input.confidence,
      createdAt,
    })
    .returning()
    .get();

  return {
    id: inserted.id,
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
  /**
   * The agent whose inbox is read. Without it, every record is read, which
   * is what a person wants and an agent never does.
   */
  agent?: string;
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
export function listRecords(db: BoardDatabase, query: InboxQuery): InboxResult {
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const cursor = query.cursor ?? 0;
  const agent = query.agent;

  // A record is unread for an agent when no row in record_reads names both.
  const unreadFor =
    agent === undefined
      ? undefined
      : sql`NOT EXISTS (
    SELECT 1 FROM ${recordReads}
     WHERE ${recordReads.recordId} = ${records.id}
       AND ${recordReads.agent} = ${agent}
  )`;

  const addressed =
    agent === undefined ? undefined : or(eq(records.toAgent, agent), isNull(records.toAgent));

  const rows = db
    .select()
    .from(records)
    .where(
      agent === undefined
        ? gt(records.id, cursor)
        : and(gt(records.id, cursor), addressed, unreadFor),
    )
    .orderBy(records.id)
    .limit(limit)
    .all();

  const found = rows.map((row) => toRecord(row, false));

  const unreadRow = db
    .select({ count: sql<number>`count(*)` })
    .from(records)
    .where(agent === undefined ? gt(records.id, cursor) : and(addressed, unreadFor))
    .get();

  if (query.markRead !== false && agent !== undefined && found.length > 0) {
    const readAt = new Date().toISOString();
    db.insert(recordReads)
      .values(found.map((record) => ({ recordId: record.id, agent, readAt })))
      .onConflictDoNothing()
      .run();
  }

  const nextCursor = found.at(-1)?.id ?? cursor;

  return { records: found, nextCursor, unread: Number(unreadRow?.count ?? 0) };
}
