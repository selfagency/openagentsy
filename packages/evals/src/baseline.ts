import type { OpencodeClient } from '@opencode-ai/sdk';

/**
 * The token baseline.
 *
 * The plan's exit test for phase 0 is fewer tokens per resolved task than a
 * plain OpenCode session. So the same task runs twice: once in a bare
 * directory, once with the agents, the plugin and the board. The tokens of
 * every session that belongs to the run are counted, the subagents included,
 * because a run that hides its cost in child sessions has not saved
 * anything.
 *
 * The arms run the same model, so the comparison is about the system and not
 * about the model.
 */

export type TokenTotals = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /** The sessions that carried the run, the parent and its children. */
  sessions: number;
  /** The tokens per session, so a layer that costs can be named. */
  bySession: { id: string; title: string; total: number }[];
};

function emptyTotals(): TokenTotals {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    sessions: 0,
    bySession: [],
  };
}

type TokenUsage = {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
};

/**
 * The session and every session below it.
 *
 * A subagent runs in its own session, and its parent session holds only the
 * task it was given. Counting the parent alone would count the orchestration
 * and hide the work.
 */
async function sessionTree(
  client: OpencodeClient,
  directory: string,
  sessionID: string,
): Promise<string[]> {
  const sessions = await client.session.list({ query: { directory } });
  const all = sessions.data ?? [];

  const tree = [sessionID];
  const seen = new Set(tree);
  const queue = [sessionID];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const session of all) {
      if (session.parentID !== current) continue;
      if (seen.has(session.id)) continue;
      seen.add(session.id);
      tree.push(session.id);
      queue.push(session.id);
    }
  }
  return tree;
}

/**
 * The tokens of one session and every session below it.
 */
export async function tokensFor(
  client: OpencodeClient,
  directory: string,
  sessionID: string,
): Promise<TokenTotals> {
  const tree = await sessionTree(client, directory, sessionID);
  const sessions = await client.session.list({ query: { directory } });
  const titles = new Map((sessions.data ?? []).map((session) => [session.id, session.title]));

  const totals = emptyTotals();
  for (const id of tree) {
    const messages = await client.session.messages({ path: { id }, query: { directory } });
    let sessionTotal = 0;
    for (const message of messages.data ?? []) {
      const info = message.info;
      if (info.role !== 'assistant') continue;
      const usage = info.tokens as TokenUsage;
      totals.input += usage.input;
      totals.output += usage.output;
      totals.reasoning += usage.reasoning;
      totals.cacheRead += usage.cache.read;
      totals.cacheWrite += usage.cache.write;
      totals.cost += info.cost;
      sessionTotal += usage.input + usage.output + usage.reasoning;
    }
    totals.bySession.push({ id, title: titles.get(id) ?? id, total: sessionTotal });
  }
  totals.sessions = tree.length;
  return totals;
}

/**
 * The number the plan asks about: the tokens of the whole run.
 *
 * Input, output and reasoning are counted, and the cache read is counted
 * too: a cached read is a token the provider still served, so a run that
 * leans on the cache has not spent less.
 */
export function totalTokens(totals: TokenTotals): number {
  return totals.input + totals.output + totals.reasoning + totals.cacheRead;
}

export function formatTotals(label: string, totals: TokenTotals): string {
  const lines = [
    `${label}: ${totalTokens(totals)} tokens over ${totals.sessions} session(s)`,
    `  input ${totals.input}  output ${totals.output}  reasoning ${totals.reasoning}  cache read ${totals.cacheRead}  cache write ${totals.cacheWrite}`,
  ];
  for (const session of totals.bySession) {
    lines.push(`  ${session.total}  ${session.title}`);
  }
  return lines.join('\n');
}
