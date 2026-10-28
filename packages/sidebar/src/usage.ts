import type { SessionMessageAssistant, SessionMessageInfo } from '@opencode/client';
import { type Plugin, usePlugin } from '@opencode/plugin/tui';
import { createEffect, createMemo } from 'solid-js';

/**
 * The usage of a session, and of the sessions it spawned.
 *
 * A subagent runs in its own session, so the numbers of a lead that spawned
 * three builders are spread over four sessions. The family is the set of
 * sessions that belong to one another, and the block reads all of them.
 */

/** What one model cost, over the whole family. */
export interface UsageRow {
  /** The provider and the model, as `provider/model`. */
  readonly key: string;
  readonly providerID: string;
  readonly modelID: string;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: number;
  /** The seconds the model spent generating. */
  readonly genSeconds: number;
}

/** A row while it is being accumulated. */
interface MutableRow {
  key: string;
  providerID: string;
  modelID: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  genSeconds: number;
}

/** The seconds a message spent generating, from its own timestamps. */
function generationSeconds(message: SessionMessageAssistant): number {
  const started = message.time.created;
  const ended = message.time.completed ?? message.time.streamed ?? started;
  return Math.max(0, ended - started) / 1000;
}

/** Whether a message is one the model answered. */
function isAssistant(message: SessionMessageInfo): message is SessionMessageAssistant {
  return message.type === 'assistant';
}

/**
 * The row a message belongs to.
 *
 * A message that was already counted is counted once, even when the family
 * lists the same session twice.
 */
function rowFor(
  message: SessionMessageInfo,
  seen: Set<string>,
  rows: Map<string, MutableRow>,
): MutableRow | undefined {
  if (!isAssistant(message)) return undefined;
  if (seen.has(message.id)) return undefined;
  seen.add(message.id);

  const providerID = message.model.providerID;
  const modelID = message.model.id;
  const key = `${providerID}/${modelID}`;
  const existing = rows.get(key);
  if (existing) return existing;

  const row: MutableRow = {
    key,
    providerID,
    modelID,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    genSeconds: 0,
  };
  rows.set(key, row);
  return row;
}

/** What one message adds to its row. */
function addTo(row: MutableRow, message: SessionMessageAssistant): void {
  row.output += (message.tokens?.output ?? 0) + (message.tokens?.reasoning ?? 0);
  row.input += message.tokens?.input ?? 0;
  row.cacheRead += message.tokens?.cache.read ?? 0;
  row.cacheWrite += message.tokens?.cache.write ?? 0;
  row.cost += message.cost ?? 0;
  row.genSeconds += generationSeconds(message);
}

/** The rows of every message of the family, one row per model. */
function aggregate(context: Plugin.Context, sessionIDs: readonly string[]): UsageRow[] {
  const seen = new Set<string>();
  const rows = new Map<string, MutableRow>();

  for (const sessionID of sessionIDs) {
    for (const message of context.data.session.message.list(sessionID)) {
      const row = rowFor(message, seen, rows);
      if (!row || !isAssistant(message)) continue;
      addTo(row, message);
    }
  }

  return [...rows.values()].sort((a, b) => b.output - a.output);
}

/**
 * The usage of the session family, as a reactive value.
 *
 * The family is the session and the sessions it spawned. The host answers
 * with their ids, so the hook reads the messages of each of them.
 */
export function useFamilyUsage(sessionID: () => string): () => UsageRow[] {
  const context = usePlugin();

  const family = createMemo(() => {
    const ids = context.data.session.family(sessionID());
    return ids.length > 0 ? ids : [sessionID()];
  });

  createEffect(() => {
    for (const id of family()) void context.data.session.message.sync(id);
  });

  return createMemo(() => aggregate(context, family()));
}
