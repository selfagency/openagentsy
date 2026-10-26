import { Database } from 'bun:sqlite';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { redact } from '@openagentsy/core';
import { z } from 'zod';
import { withBusyRetry } from './db.js';
import type { WasteKind } from './schema.js';

/**
 * The ingest path (§6.2).
 *
 * The role arrives already resolved: the adapter's resolver turns an agent
 * id into a role key before the message is written, so the ledger never sees
 * `agentsy` where it means `lead`. The ledger stores the role it is given,
 * verbatim, and never resolves one. The contract is in `SCHEMA.md`.
 */

/**
 * The providers that fold the reasoning tokens into the output count.
 *
 * OpenCode reports reasoning separately from output, and some providers
 * count it twice. The Codex family does, so the reasoning is subtracted
 * before the row is written and the tokens are counted once.
 */
export const REASONING_IN_OUTPUT: ReadonlySet<string> = new Set([
  'codex',
  'openai-codex',
  'openai-codex-mini',
]);

/** The token counts of one message. */
export const messageTokensSchema = z.object({
  input: z.number().optional(),
  output: z.number().optional(),
  reasoning: z.number().optional(),
  cache: z.object({ read: z.number().optional(), write: z.number().optional() }).optional(),
});

/** The normalized shape the ledger stores. */
export const assistantMessageSchema = z.object({
  id: z.string().min(1),
  sessionID: z.string(),
  providerID: z.string(),
  modelID: z.string(),
  tokens: messageTokensSchema.optional(),
  cost: z.number().optional(),
});

/** What the caller knows and the message does not. */
export const ingestCtxSchema = z.object({
  rootSessionId: z.string().min(1),
  role: z.string().min(1),
  latencyMs: z.number().int().nonnegative().optional(),
  activeTaskId: z.string().min(1).optional(),
  ts: z.string().min(1),
});

export type MessageTokens = z.infer<typeof messageTokensSchema>;
export type AssistantMessage = z.infer<typeof assistantMessageSchema>;
export type IngestCtx = z.infer<typeof ingestCtxSchema>;

/** A number, or zero. A token count is never a guess. */
function n(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Normalize a message from OpenCode.
 *
 * The host nests the model under `message.model` on V2 and names it flat on
 * V1, and the plan asks for both to work, so the reader is written
 * tolerantly: every name it knows is tried, and a name it does not know
 * leaves the field empty rather than throwing. Only a message without an id
 * is refused, because the id is the dedup key.
 */
export function normalizeOcMessage(raw: unknown): AssistantMessage {
  const outer = record(raw);
  const inner = record(outer.message);
  // The host hands the message over on V2, and the message itself on V1.
  const message = readString(inner.id) === undefined ? outer : inner;
  const model = record(message.model);
  const tokens = record(message.tokens);
  const cache = record(tokens.cache);

  const id =
    readString(message.id) ?? readString(message.messageID) ?? readString(message.message_id);
  if (id === undefined) {
    throw new Error('the message has no id, so it cannot be deduplicated');
  }

  const cost =
    typeof message.cost === 'number' && Number.isFinite(message.cost) ? message.cost : undefined;

  return {
    id,
    sessionID:
      readString(message.sessionID) ??
      readString(message.sessionId) ??
      readString(message.session_id) ??
      '',
    providerID:
      readString(message.providerID) ??
      readString(message.providerId) ??
      readString(message.provider) ??
      readString(model.providerID) ??
      readString(model.provider) ??
      '',
    modelID:
      readString(message.modelID) ??
      readString(message.modelId) ??
      readString(model.id) ??
      readString(model.modelID) ??
      '',
    tokens: {
      input: n(tokens.input),
      output: n(tokens.output),
      reasoning: n(tokens.reasoning),
      cache: { read: n(cache.read), write: n(cache.write) },
    },
    ...(cost !== undefined ? { cost } : {}),
  };
}

/**
 * The output tokens of a message, with the reasoning counted once.
 *
 * The live path and the backfill both go through here, so a message that
 * was counted once cannot be counted twice by the other path.
 */
function outputTokens(provider: string, tokens: MessageTokens): number {
  const reasoning = n(tokens.reasoning);
  return REASONING_IN_OUTPUT.has(provider.toLowerCase())
    ? Math.max(0, n(tokens.output) - reasoning)
    : n(tokens.output);
}

const USAGE_INSERT = `INSERT OR IGNORE INTO usage
  (message_id, session_id, root_session_id, role, provider, model, input, output, reasoning,
   cache_read, cache_write, cost_reported, latency_ms, task_id, ts)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

/**
 * Record one assistant message.
 *
 * The row is written once: the message id is the dedup key, so replaying a
 * session does not change the totals. A reported cost is stored only when it
 * is a real positive number, and a message without one leaves
 * `cost_reported` empty — the pricing chain fills `cost_estimated` later, and
 * an unpriced model stays empty rather than becoming zero.
 */
export function recordAssistantMessage(
  db: Database,
  message: AssistantMessage,
  ctx: IngestCtx,
): void {
  // The row is written from what the schemas accept, so a number that is not
  // a number stops here instead of in a report.
  const m = assistantMessageSchema.parse(message);
  const context = ingestCtxSchema.parse(ctx);
  const tokens = m.tokens ?? {};
  const reasoning = n(tokens.reasoning);
  const output = outputTokens(m.providerID, tokens);

  withBusyRetry(() => {
    db.query(USAGE_INSERT).run(
      m.id,
      m.sessionID,
      context.rootSessionId,
      context.role,
      m.providerID,
      m.modelID,
      n(tokens.input),
      output,
      reasoning,
      n(tokens.cache?.read),
      n(tokens.cache?.write),
      typeof m.cost === 'number' && m.cost > 0 ? m.cost : null,
      context.latencyMs ?? null,
      context.activeTaskId ?? null,
      context.ts,
    );
  });
}

const WASTE_INSERT = `INSERT INTO waste
  (root_session_id, message_id, kind, tokens, detail, ts)
  VALUES (?,?,?,?,?,?)`;

/**
 * Record a waste signal (§6.4).
 *
 * The detail is free text, so it goes through the redaction first: a secret
 * that reached a waste row would be a secret on disk.
 */
export function recordWaste(
  db: Database,
  waste: {
    rootSessionId?: string | undefined;
    messageId?: string | undefined;
    kind: WasteKind;
    tokens: number;
    detail?: string | undefined;
    ts: string;
  },
): void {
  const detail = waste.detail === undefined ? null : redact(waste.detail).text;
  withBusyRetry(() => {
    db.query(WASTE_INSERT).run(
      waste.rootSessionId ?? null,
      waste.messageId ?? null,
      waste.kind,
      waste.tokens,
      detail,
      waste.ts,
    );
  });
}

/** A backfill that cannot trust the shape of the file it was pointed at. */
export class BackfillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackfillError';
  }
}

export type BackfillOptions = {
  /** Off by default: a backfill reads another program's database. */
  enabled?: boolean;
  /** Where OpenCode keeps its storage. */
  dataDir?: string;
  /** The newest rows to import. */
  limit?: number;
};

export type BackfillResult = {
  enabled: boolean;
  imported: number;
  files: string[];
  errors: string[];
};

/** The database files of a storage directory, without the sidecars. */
function listDatabases(dataDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dataDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith('opencode') && name.endsWith('.db'))
    .filter((name) => !name.endsWith('-wal') && !name.endsWith('-shm'))
    .sort()
    .map((name) => join(dataDir, name));
}

/** The columns of a table, as the file has them. */
function tableColumns(source: Database, table: string): Set<string> {
  const rows = source.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map((row) => row.name));
}

/** The tables of a file. */
function tableNames(source: Database): Set<string> {
  const rows = source.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
    name: string;
  }[];
  return new Set(rows.map((row) => row.name));
}

/**
 * Check the shape of the file before it is read.
 *
 * The OpenCode storage is internal and changes between versions, so the
 * columns this backfill needs are checked and a file that does not carry
 * them is refused with what it does carry. Guessing would import garbage.
 */
function verifySchema(source: Database, path: string): void {
  const tables = tableNames(source);
  if (!tables.has('message')) {
    const found = [...tables].sort().join(', ') || 'no tables';
    throw new BackfillError(
      `${path}: there is no "message" table; this OpenCode version has ${found}`,
    );
  }
  const columns = tableColumns(source, 'message');
  const missing = ['id', 'session_id', 'time_created', 'data'].filter(
    (column) => !columns.has(column),
  );
  if (missing.length > 0) {
    throw new BackfillError(
      `${path}: the "message" table has no ${missing.join(', ')} column; this OpenCode version has ${[...columns].join(', ')}`,
    );
  }
}

/** The parent of every session, when the file records one. */
function sessionParents(source: Database): Map<string, string | undefined> {
  const parents = new Map<string, string | undefined>();
  if (!tableNames(source).has('session')) return parents;
  if (!tableColumns(source, 'session').has('parent_id')) return parents;
  const rows = source.query('SELECT id, parent_id FROM session').all() as {
    id: string;
    parent_id: string | null;
  }[];
  for (const row of rows) {
    parents.set(row.id, row.parent_id ?? undefined);
  }
  return parents;
}

/** The session at the top of the chain, with a bound on the walk. */
function rootSessionOf(parents: Map<string, string | undefined>, sessionId: string): string {
  let current = sessionId;
  for (let depth = 0; depth < 64; depth += 1) {
    const parent = parents.get(current);
    if (parent === undefined || parent === current) return current;
    current = parent;
  }
  return current;
}

function parseJson(text: unknown): Record<string, unknown> | null {
  if (typeof text !== 'string') return null;
  try {
    return record(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * Import the past messages of an OpenCode storage.
 *
 * The role cannot be resolved for an imported message: the raw agent id is
 * all that is there, so it lands in `role_raw` and the row is left out of
 * the per-role reports rather than mis-attributed. The import is off unless
 * it is asked for, and it never writes to the file it reads.
 */
export function backfillFromOpencode(db: Database, options: BackfillOptions = {}): BackfillResult {
  if (options.enabled !== true) {
    return { enabled: false, imported: 0, files: [], errors: [] };
  }

  const dataDir = options.dataDir ?? join(homedir(), '.local', 'share', 'opencode');
  const limit = options.limit ?? 10_000;
  const files = listDatabases(dataDir);

  let imported = 0;
  const errors: string[] = [];
  for (const file of files) {
    try {
      imported += importFile(db, file, limit);
    } catch (error) {
      errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { enabled: true, imported, files, errors };
}

/** Import one storage file. */
function importFile(db: Database, path: string, limit: number): number {
  const source = new Database(path, { readonly: true });
  try {
    verifySchema(source, path);
    const parents = sessionParents(source);
    const rows = source
      .query(
        'SELECT id, session_id, time_created, data FROM message ORDER BY time_created DESC LIMIT ?',
      )
      .all(limit) as { id: string; session_id: string; time_created: number; data: string }[];

    let imported = 0;
    for (const row of rows) {
      const data = parseJson(row.data);
      if (data === null) continue;
      if (readString(data.role) !== 'assistant') continue;

      const message = normalizeOcMessage({ ...data, id: row.id, sessionID: row.session_id });
      const agent = readString(data.agent) ?? readString(data.mode) ?? null;
      const created = Number(row.time_created);
      const ts = Number.isFinite(created)
        ? new Date(created).toISOString()
        : new Date(0).toISOString();

      const result = withBusyRetry(() => {
        return db
          .query(
            `INSERT OR IGNORE INTO usage
              (message_id, session_id, root_session_id, role, role_raw, provider, model, input, output,
               reasoning, cache_read, cache_write, cost_reported, ts)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            message.id,
            row.session_id,
            rootSessionOf(parents, row.session_id),
            null,
            agent,
            message.providerID,
            message.modelID,
            n(message.tokens?.input),
            outputTokens(message.providerID, message.tokens ?? {}),
            n(message.tokens?.reasoning),
            n(message.tokens?.cache?.read),
            n(message.tokens?.cache?.write),
            typeof message.cost === 'number' && message.cost > 0 ? message.cost : null,
            ts,
          );
      });
      imported += result.changes;
    }
    return imported;
  } finally {
    source.close();
  }
}
