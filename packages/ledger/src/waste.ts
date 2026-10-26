import { Database } from 'bun:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gitCommits, gitText, refsTrailers } from './git.js';
import {
  type AssistantMessage,
  listOpencodeDatabases,
  normalizeOcMessage,
  parseJson,
  recordWaste,
  tableColumns,
  tableNames,
} from './ingest.js';
import type { WasteKind } from './schema.js';

/**
 * The waste signals of §6.4 — and who finds them.
 *
 * The seven kinds of §6.4 split in two, and the split is by what the
 * detector needs to see:
 *
 * - `cache_miss`, `no_progress` and `reverted_code` are computable from what
 *   is already on disk — OpenCode's own storage, the board's records and the
 *   repository — so this module finds them. They need no live event.
 * - `retry`, `tool_error_loop`, `interrupted` and `undo` are properties of a
 *   tool call while it happens: they need the event bridge of the plugin, so
 *   they are recorded by the bridge through the same `recordWaste` this
 *   module writes with. `HOOK_WASTE_KINDS` names them, so the two halves can
 *   be counted apart.
 *
 * The full list of the seven is `WASTE_KINDS` in the schema, and the CHECK
 * constraint on the `waste` table holds all of them.
 */

/** The kinds this module can find on its own. */
export const DETECTED_WASTE_KINDS = ['cache_miss', 'no_progress', 'reverted_code'] as const;

/** The kinds the event bridge finds, because they live in the tool call. */
export const HOOK_WASTE_KINDS = ['retry', 'tool_error_loop', 'interrupted', 'undo'] as const;

/** The ratio below which a turn counts as a cache miss (§6.4). */
export const CACHE_MISS_RATIO = 0.5;

/** How long a revert may take before it is not a revert any more (§6.4). */
export const REVERT_WINDOW_DAYS = 14;

/** A waste signal, ready to be written. */
export type WasteCandidate = {
  kind: WasteKind;
  tokens: number;
  ts: string;
  rootSessionId?: string | undefined;
  messageId?: string | undefined;
  detail?: string | undefined;
};

/** A number, or zero. A token count is never a guess. */
function n(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Write the waste signals, and skip the ones that are already there.
 *
 * A detector is a command: it runs again and again over the same history,
 * so it must not count the same turn twice. The dedup key is the kind and
 * the message for a message-bound signal, and the kind, the time and the
 * detail for one that has no message.
 */
export function recordWasteRows(db: Database, rows: WasteCandidate[]): number {
  let written = 0;
  for (const row of rows) {
    if (wasteExists(db, row)) continue;
    recordWaste(db, {
      kind: row.kind,
      tokens: row.tokens,
      ts: row.ts,
      ...(row.rootSessionId === undefined ? {} : { rootSessionId: row.rootSessionId }),
      ...(row.messageId === undefined ? {} : { messageId: row.messageId }),
      ...(row.detail === undefined ? {} : { detail: row.detail }),
    });
    written += 1;
  }
  return written;
}

/** Whether the ledger already holds this signal. */
function wasteExists(db: Database, row: WasteCandidate): boolean {
  if (row.messageId !== undefined) {
    const found = db
      .query('SELECT 1 FROM waste WHERE kind = ? AND message_id = ? LIMIT 1')
      .get(row.kind, row.messageId);
    return found !== null;
  }
  const found = db
    .query(
      'SELECT 1 FROM waste WHERE kind = ? AND message_id IS NULL AND ts = ? AND detail IS ? LIMIT 1',
    )
    .get(row.kind, row.ts, row.detail ?? null);
  return found !== null;
}

/** The sessions the ledger knows, so the storage is only read where it is needed. */
function ledgerSessions(db: Database): string[] {
  const rows = db.query('SELECT DISTINCT session_id FROM usage').all() as { session_id: string }[];
  return rows.map((row) => row.session_id).filter((id) => id.length > 0);
}

/** The root session of every message the ledger knows. */
function rootSessions(db: Database): Map<string, string> {
  const rows = db.query('SELECT message_id, root_session_id FROM usage').all() as {
    message_id: string;
    root_session_id: string;
  }[];
  const map = new Map<string, string>();
  for (const row of rows) map.set(row.message_id, row.root_session_id);
  return map;
}

/**
 * The root session of every session the ledger knows.
 *
 * A turn the ledger has not ingested yet still belongs to a session, and the
 * session knows its root: that is where the turn is counted.
 */
function sessionRoots(db: Database): Map<string, string> {
  const rows = db.query('SELECT session_id, root_session_id FROM usage').all() as {
    session_id: string;
    root_session_id: string;
  }[];
  const map = new Map<string, string>();
  for (const row of rows) {
    if (!map.has(row.session_id)) map.set(row.session_id, row.root_session_id);
  }
  return map;
}

/** One message of an OpenCode storage. */
type StoredMessage = {
  id: string;
  role: string;
  session: string;
  /** When it was written, in milliseconds since the epoch. */
  created: number;
  /**
   * Whether a user message carried any text. Undefined when the storage
   * records no parts, in which case the message list alone decides.
   */
  hasText?: boolean | undefined;
  message: AssistantMessage;
};

/**
 * The messages of one session, in the order they were written.
 *
 * The storage is another program's database, so the file is opened read-only
 * and its shape is checked before it is read. A file that does not carry the
 * columns this needs is skipped, not guessed at.
 */
function readSessionMessages(source: Database, sessionId: string): StoredMessage[] {
  if (!tableNames(source).has('message')) return [];
  const columns = tableColumns(source, 'message');
  for (const column of ['id', 'session_id', 'time_created', 'data']) {
    if (!columns.has(column)) return [];
  }

  const rows = source
    .query(
      'SELECT id, session_id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id',
    )
    .all(sessionId) as { id: string; session_id: string; time_created: number; data: string }[];

  const messages: StoredMessage[] = [];
  for (const row of rows) {
    const data = parseJson(row.data);
    if (data === null) continue;
    const role = asString(data.role);
    if (role !== 'assistant' && role !== 'user') continue;
    messages.push({
      id: row.id,
      role,
      session: row.session_id,
      created: Number(row.time_created),
      ...(role === 'user' ? { hasText: userHasText(source, row.id) } : {}),
      message: normalizeOcMessage({ ...data, id: row.id, sessionID: row.session_id }),
    });
  }
  return messages;
}

/**
 * Whether a user message carried anything the user wrote.
 *
 * The plan counts a turn that had "no new user parts" since the previous
 * assistant message, and a user message that carries no text part is not a
 * new user turn: it is the host handing something over. When the storage
 * records no parts at all, the answer is undefined and the message list
 * alone decides — a user message then counts as a turn.
 */
function userHasText(source: Database, messageId: string): boolean | undefined {
  if (!tableNames(source).has('part')) return undefined;
  const rows = source.query('SELECT data FROM part WHERE message_id = ?').all(messageId) as {
    data: string;
  }[];
  for (const row of rows) {
    const data = parseJson(row.data);
    if (data === null) continue;
    if (asString(data.type) !== 'text') continue;
    const text = asString(data.text);
    if (text !== undefined && text.trim().length > 0) return true;
  }
  return false;
}

/** Whether a signal happened after the instant the caller asked for. */
function afterSince(ts: string, since: string | undefined): boolean {
  return since === undefined || ts >= since;
}

/** What the cache-miss detector needs to know. */
export type CacheMissOptions = {
  /** Where OpenCode keeps its storage. */
  dataDir?: string | undefined;
  /** Only the turns that happened after this instant. */
  since?: string | undefined;
  /** The sessions to read; by default the sessions the ledger knows. */
  sessions?: string[] | undefined;
  /** The ratio below which a turn counts as a miss. */
  threshold?: number | undefined;
};

/**
 * The cache misses of §6.4.
 *
 * A turn with no new user parts since the previous assistant message is a
 * retry or a continuation: the prefix was unchanged by definition, so a low
 * cache ratio is the model's problem and not the user's. The detection reads
 * the message list of a session: the pair is the previous assistant message
 * and the one after it, and a user message between them ends the pair. A
 * user message that carried no text part does not end it — nothing new came
 * from the user — but only when the storage records parts at all.
 *
 * The tokens counted are the uncached input of the turn — the part of the
 * prefix the model had to read again.
 */
export function detectCacheMiss(db: Database, options: CacheMissOptions = {}): WasteCandidate[] {
  const threshold = options.threshold ?? CACHE_MISS_RATIO;
  const dataDir = options.dataDir ?? join(homedir(), '.local', 'share', 'opencode');
  const sessions = options.sessions ?? ledgerSessions(db);
  if (sessions.length === 0) return [];

  const roots = rootSessions(db);
  const rootsBySession = sessionRoots(db);
  const candidates: WasteCandidate[] = [];
  for (const file of listOpencodeDatabases(dataDir)) {
    const source = openReadonly(file);
    if (source === null) continue;
    try {
      for (const session of sessions) {
        candidates.push(
          ...cacheMissInSession(source, session, threshold, roots, rootsBySession, options.since),
        );
      }
    } finally {
      source.close();
    }
  }
  return candidates;
}

/**
 * The cache misses of one session.
 *
 * The pair is the previous assistant message and the one after it, and a
 * user message between them ends the pair. A user message that carried
 * nothing the user wrote does not end it: no new user parts came in, and
 * the turn is still a continuation.
 */
function cacheMissInSession(
  source: Database,
  session: string,
  threshold: number,
  roots: Map<string, string>,
  rootsBySession: Map<string, string>,
  since: string | undefined,
): WasteCandidate[] {
  const candidates: WasteCandidate[] = [];
  let previousAssistant: StoredMessage | undefined;
  for (const current of readSessionMessages(source, session)) {
    if (current.role === 'user') {
      if (current.hasText !== false) previousAssistant = undefined;
      continue;
    }
    const previous = previousAssistant;
    previousAssistant = current;
    if (previous === undefined) continue;

    const candidate = cacheMissOf(current, threshold, roots, rootsBySession);
    if (candidate === undefined) continue;
    if (!afterSince(candidate.ts, since)) continue;
    candidates.push(candidate);
  }
  return candidates;
}

/**
 * The cache miss of one turn, when the turn is one.
 *
 * The ratio is `cache_read / (input + cache_read)`, and the tokens counted
 * are the uncached input: the part of the prefix the model read again.
 */
function cacheMissOf(
  current: StoredMessage,
  threshold: number,
  roots: Map<string, string>,
  rootsBySession: Map<string, string>,
): WasteCandidate | undefined {
  const tokens = current.message.tokens ?? {};
  const input = n(tokens.input);
  const cacheRead = n(tokens.cache?.read);
  const total = input + cacheRead;
  if (total <= 0) return undefined;
  const ratio = cacheRead / total;
  if (ratio >= threshold) return undefined;

  const rootSessionId = roots.get(current.id) ?? rootsBySession.get(current.session);
  return {
    kind: 'cache_miss',
    tokens: input,
    ts: Number.isFinite(current.created)
      ? new Date(current.created).toISOString()
      : new Date().toISOString(),
    messageId: current.id,
    ...(rootSessionId === undefined ? {} : { rootSessionId }),
    detail: `cache read ${cacheRead} of ${total} (${Math.round(ratio * 100)}%) with no new user turn`,
  };
}

/** A record on the board. */
type BoardRecordRow = {
  id: number;
  from_agent: string;
  to_agent: string | null;
  created_at: string;
};

/** What the board holds, as the detector reads it. */
type BoardSnapshot = {
  records: BoardRecordRow[];
  reads: { agent: string; read_at: string }[];
  leases: { agent: string; granted_at: string }[];
};

/**
 * Read the board, and only the parts of it the detector needs.
 *
 * The board's tables are read with plain SQL: the ledger holds no
 * dependency on the board's query layer, and a table that is not there — an
 * older board, a board that was never used — is an empty list and not a
 * failure.
 */
function readBoard(boardDb: Database): BoardSnapshot {
  const snapshot: BoardSnapshot = { records: [], reads: [], leases: [] };
  const names = tableNames(boardDb);
  if (!names.has('records')) return snapshot;

  snapshot.records = boardDb
    .query('SELECT id, from_agent, to_agent, created_at FROM records ORDER BY created_at, id')
    .all() as BoardRecordRow[];

  if (names.has('record_reads')) {
    snapshot.reads = boardDb.query('SELECT agent, read_at FROM record_reads').all() as {
      agent: string;
      read_at: string;
    }[];
  }
  if (names.has('leases')) {
    snapshot.leases = boardDb.query('SELECT agent, granted_at FROM leases').all() as {
      agent: string;
      granted_at: string;
    }[];
  }
  return snapshot;
}

/** What the no-progress detector needs to know. */
export type NoProgressOptions = {
  /** The agent id the Lead writes its records under. */
  leadAgent?: string | undefined;
  /** The role key the Lead's usage rows carry. */
  leadRole?: string | undefined;
  /** Only the rounds that closed after this instant. */
  since?: string | undefined;
};

/** The beginning of time, as a timestamp the board can be compared against. */
const ROUND_START = '';
/** The end of time, as a timestamp the board can be compared against. */
const ROUND_END = '9999-12-31T23:59:59.999Z';

/** One round of the Lead's loop, and what it cost. */
type LeadRound = {
  start: string;
  end: string;
  tokens: number;
  messages: number;
  rootSessionId?: string | undefined;
  messageId?: string | undefined;
};

/**
 * The rounds of the Lead's loop, and the tokens of each.
 *
 * **The round window rule.** A round is one pass of the Lead's recovery loop
 * (§8.7): the Lead's messages from just after its own previous board record
 * up to and including its next one. The Lead's record ends the round,
 * because the PERSIST stage of the loop is what writes it. A Lead that never
 * wrote a record has one round that runs to the end of the window.
 *
 * The tokens of a round are the Lead's own tokens inside it.
 */
/** A Lead message of the ledger. */
type LeadMessageRow = {
  message_id: string;
  root_session_id: string;
  input: number;
  output: number;
  reasoning: number;
  cache_write: number;
  ts: string;
};

/** The Lead messages of the ledger, in the order they were made. */
function readLeadMessages(db: Database, leadRole: string): LeadMessageRow[] {
  return db
    .query(
      `SELECT message_id, root_session_id, input, output, reasoning, cache_write, ts
       FROM usage WHERE role = ? ORDER BY ts, message_id`,
    )
    .all(leadRole) as LeadMessageRow[];
}

/**
 * The boundaries of the Lead's rounds.
 *
 * The first boundary is the beginning of the window and the last one is the
 * end of it; every record the Lead wrote closes a round.
 */
function leadBoundaries(board: BoardSnapshot, leadAgent: string): string[] {
  const records = board.records.filter((record) => record.from_agent === leadAgent);
  return [ROUND_START, ...records.map((record) => record.created_at), ROUND_END];
}

/** The Lead messages that fall inside a round, and what they cost. */
function roundOf(rows: LeadMessageRow[], start: string, end: string): LeadRound {
  const round: LeadRound = { start, end, tokens: 0, messages: 0 };
  for (const row of rows) {
    if (row.ts <= start || row.ts > end) continue;
    round.tokens += n(row.input) + n(row.output) + n(row.reasoning) + n(row.cache_write);
    round.messages += 1;
    if (round.messageId === undefined) round.messageId = row.message_id;
    if (round.rootSessionId === undefined) round.rootSessionId = row.root_session_id;
  }
  return round;
}

function leadRounds(
  db: Database,
  board: BoardSnapshot,
  leadAgent: string,
  leadRole: string,
): LeadRound[] {
  const rows = readLeadMessages(db, leadRole);
  const boundaries = leadBoundaries(board, leadAgent);
  return boundaries
    .slice(1)
    .map((end, index) => roundOf(rows, boundaries[index] ?? ROUND_START, end));
}

/**
 * Whether a round made progress.
 *
 * A round made progress when it dispatched something, when it consumed a
 * result or when the board moved under it. A round that did none of the
 * three changed nothing, and it is the waste of §6.4.
 */
function roundProgressed(board: BoardSnapshot, round: LeadRound, leadAgent: string): boolean {
  const inside = board.records.filter(
    (record) => record.created_at > round.start && record.created_at <= round.end,
  );
  if (inside.some((record) => record.to_agent !== null)) return true;
  if (inside.some((record) => record.to_agent === leadAgent)) return true;
  if (
    board.reads.some(
      (read) => read.agent === leadAgent && read.read_at > round.start && read.read_at <= round.end,
    )
  ) {
    return true;
  }
  if (inside.some((record) => record.from_agent !== leadAgent)) return true;
  return board.leases.some(
    (lease) => lease.granted_at > round.start && lease.granted_at <= round.end,
  );
}

/**
 * The rounds of the Lead that went nowhere (§6.4, §8.7).
 *
 * A round that dispatched nothing, consumed no results and changed nothing
 * on the board cannot claim progress, so it is written down as waste. The
 * tokens counted are the round's tokens — the Lead's own.
 */
export function detectNoProgress(
  db: Database,
  boardDb: Database,
  options: NoProgressOptions = {},
): WasteCandidate[] {
  const { agent: leadAgent, role: leadRole } = leadIdentity(options);
  const board = readBoard(boardDb);
  const candidates: WasteCandidate[] = [];

  for (const round of leadRounds(db, board, leadAgent, leadRole)) {
    if (round.tokens <= 0) continue;
    const end = roundEnd(db, leadRole, round);
    if (options.since !== undefined && end < options.since) continue;
    if (roundProgressed(board, round, leadAgent)) continue;

    candidates.push(noProgressCandidate(round, end));
  }
  return candidates;
}

/** The agent the Lead writes under, and the role its ledger rows carry. */
function leadIdentity(options: NoProgressOptions): { agent: string; role: string } {
  return { agent: options.leadAgent ?? 'agentsy', role: options.leadRole ?? 'lead' };
}

/** The end of a round, when the round never closed. */
function roundEnd(db: Database, leadRole: string, round: LeadRound): string {
  return round.end === ROUND_END ? lastMessageTs(db, leadRole, round) : round.end;
}

/** The waste signal of a round that made no progress. */
function noProgressCandidate(round: LeadRound, end: string): WasteCandidate {
  return {
    kind: 'no_progress',
    tokens: round.tokens,
    ts: end,
    ...(round.rootSessionId === undefined ? {} : { rootSessionId: round.rootSessionId }),
    ...(round.messageId === undefined ? {} : { messageId: round.messageId }),
    detail: `lead round with no dispatch, no result and no board change (${round.messages} message(s))`,
  };
}

/** The time of the newest Lead message, for a round that never closed. */
function lastMessageTs(db: Database, leadRole: string, round: LeadRound): string {
  const row = db
    .query('SELECT MAX(ts) AS ts FROM usage WHERE role = ? AND ts > ? AND ts <= ?')
    .get(leadRole, round.start, round.end) as { ts: string | null } | null;
  return row?.ts ?? new Date().toISOString();
}

/**
 * The no-progress rounds, read from the board at a path.
 *
 * The board is opened read-only and closed again here, so a caller does not
 * have to know how the board is stored.
 */
export function detectNoProgressAtPath(
  db: Database,
  boardPath: string,
  options: NoProgressOptions = {},
): WasteCandidate[] {
  const boardDb = openReadonly(boardPath);
  if (boardDb === null) return [];
  try {
    return detectNoProgress(db, boardDb, options);
  } finally {
    boardDb.close();
  }
}

/** Open a database read-only, or null when it cannot be opened. */
function openReadonly(path: string): Database | null {
  try {
    return new Database(path, { readonly: true });
  } catch {
    return null;
  }
}

/** What the revert scanner needs to know. */
export type RevertOptions = {
  /** The tokens the builders of a task spent, for the share. */
  tokensForTask?: ((taskId: string) => number) | undefined;
  /** How long a revert may take. */
  windowDays?: number | undefined;
};

/**
 * The reverted code of §6.4.
 *
 * A commit that carries a `Refs:` trailer and whose lines are deleted again
 * within the window is code that was written and then taken back. The tokens
 * counted are the builder tokens of the task, times the share of the added
 * lines that were lost.
 *
 * This is a command and not a daemon: it walks the history of a repository
 * once, when a person or the Lead asks for it.
 */
export function scanReverts(
  gitDir: string,
  since: string,
  options: RevertOptions = {},
): WasteCandidate[] {
  const windowDays = options.windowDays ?? REVERT_WINDOW_DAYS;
  const candidates: WasteCandidate[] = [];

  for (const commit of gitCommits(gitDir, since)) {
    const refs = refsTrailers(commit.message);
    if (refs.length === 0) continue;
    const lines = lostLines(gitDir, commit.sha, commit.at, windowDays);
    if (lines.total === 0 || lines.lost === 0) continue;
    const share = lines.lost / lines.total;

    for (const taskId of refs) {
      const taskTokens = options.tokensForTask?.(taskId) ?? 0;
      candidates.push({
        kind: 'reverted_code',
        tokens: Math.round(taskTokens * share),
        ts: new Date(commit.at * 1000).toISOString(),
        detail: `task ${taskId}, commit ${commit.sha.slice(0, 8)}: ${lines.lost} of ${lines.total} added line(s) lost within ${windowDays} day(s)`,
      });
    }
  }
  return candidates;
}

/** The added lines of a commit, per file, and how many of them were lost. */
function lostLines(
  gitDir: string,
  sha: string,
  at: number,
  windowDays: number,
): { lost: number; total: number } {
  const numstat = gitText(gitDir, ['show', '--format=', '--numstat', sha]);
  if (numstat === null) return { lost: 0, total: 0 };

  let lost = 0;
  let total = 0;
  for (const line of numstat.split('\n')) {
    const parts = line.split('\t');
    const file = parts[2];
    if (file === undefined || file.length === 0) continue;
    const added = addedLines(gitDir, sha, file);
    if (added.length === 0) continue;
    const later = laterLines(gitDir, file, sha, at, windowDays);
    total += added.length;
    lost += countLost(added, later);
  }
  return { lost, total };
}

/** The lines a commit added to a file. */
function addedLines(gitDir: string, sha: string, file: string): string[] {
  const diff = gitText(gitDir, ['show', '--format=', '--unified=0', '--no-color', sha, '--', file]);
  if (diff === null) return [];
  const lines: string[] = [];
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const content = line.slice(1).trim();
    if (content.length === 0) continue;
    lines.push(content);
  }
  return lines;
}

/**
 * The content of a file after the window, and null when the file was not
 * touched inside it.
 */
function laterLines(
  gitDir: string,
  file: string,
  sha: string,
  at: number,
  windowDays: number,
): string[] | null {
  const until = at + windowDays * 24 * 60 * 60;
  const log = gitText(gitDir, [
    'log',
    `--since=@${at}`,
    `--until=@${until}`,
    '--format=%H',
    '--',
    file,
  ]);
  if (log === null) return null;
  for (const line of log.split('\n')) {
    const commit = line.trim();
    if (commit.length === 0 || commit === sha) continue;
    const content = gitText(gitDir, ['show', `${commit}:${file}`]);
    if (content === null) return [];
    return content
      .split('\n')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return null;
}

/**
 * How many of the added lines are gone.
 *
 * The lines are matched by their content, not by their position: a line that
 * moved is still there, and a line that was rewritten is gone. The count is
 * a multiset difference, so a line that appears twice is counted twice.
 */
function countLost(added: string[], later: string[] | null): number {
  if (later === null) return 0;
  const counts = new Map<string, number>();
  for (const line of later) counts.set(line, (counts.get(line) ?? 0) + 1);
  let lost = 0;
  for (const line of added) {
    const left = counts.get(line) ?? 0;
    if (left > 0) counts.set(line, left - 1);
    else lost += 1;
  }
  return lost;
}
