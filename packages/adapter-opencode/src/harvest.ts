import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionClient } from './client.js';

/**
 * The subagent harvest.
 *
 * When a subagent session ends, the archivist distils what the session
 * learned into candidate memories. The adapter assembles the packet and
 * launches the hidden archivist, because the adapter is the only part that
 * knows a session ended and what it touched.
 *
 * The packet is deliberately small. The archivist runs on a cheap model, and
 * the whole point of the harvest is that the Lead's history is not carried
 * into every session: the packet is the session's own transcript, trimmed,
 * plus the decisions the guard took in it.
 */

/** The roles that do not get harvested. */
const NOT_HARVESTED = new Set(['lead', 'archivist']);

/** The archivist's agent id. It is hidden, but a session can still use it. */
const ARCHIVIST = 'oa-archivist';

/** How much of the transcript the packet carries. */
const MAX_TRANSCRIPT_CHARS = 12_000;

export type HarvestClient = {
  session: SessionClient;
};

export type HarvestInput = {
  client: HarvestClient;
  root: string;
  directory: string;
  sessionID: string;
  /** The role that ran the session. */
  role: string;
  /** The agent id the session ran under. */
  agent: string;
};

/**
 * Harvest a finished subagent session.
 *
 * Returns what it did, so the caller can put it on the record. A session
 * that has nothing worth keeping is not harvested: the archivist is cheap,
 * but it is not free.
 */
export async function harvest(
  input: HarvestInput,
): Promise<{ harvested: boolean; reason: string }> {
  const { client, root, directory, sessionID, role, agent } = input;
  if (NOT_HARVESTED.has(role)) {
    return { harvested: false, reason: `${role} sessions are not harvested` };
  }

  const messages = await client.session.messages({
    path: { id: sessionID },
    query: { directory },
  });
  const transcript = transcriptOf(messages.data ?? []);
  const decisions = await decisionsOf(root, sessionID);

  // Nothing new means nothing to keep: no writes, no refusals, no words.
  if (transcript.length === 0 && decisions.length === 0) {
    return { harvested: false, reason: 'the session left nothing behind' };
  }

  const packet = buildPacket({ sessionID, role, agent, transcript, decisions });

  const created = await client.session.create({
    // The archivist session is a child of the session it harvests. It is a
    // working session, not a chapter of the person's history, and a child
    // session keeps it out of the top level list.
    body: { title: `harvest ${role}`, parentID: sessionID },
    query: { directory },
  });
  const archivistSession = created.data?.id;
  if (archivistSession === undefined) {
    return { harvested: false, reason: 'the server created no session for the archivist' };
  }

  await client.session.promptAsync({
    path: { id: archivistSession },
    body: { agent: ARCHIVIST, parts: [{ type: 'text', text: packet }] },
    query: { directory },
  });

  return { harvested: true, reason: `the archivist was given the packet of ${sessionID}` };
}

/** The words of the session, trimmed to the end, where the outcome is. */
function transcriptOf(messages: { parts?: { type: string; text?: string }[] }[]): string {
  const texts: string[] = [];
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (part.type !== 'text') continue;
      const text = part.text?.trim();
      if (text) texts.push(text);
    }
  }
  const joined = texts.join('\n');
  if (joined.length <= MAX_TRANSCRIPT_CHARS) return joined;
  return `…earlier omitted…\n${joined.slice(-MAX_TRANSCRIPT_CHARS)}`;
}

/** The decisions the guard took in the session: the writes and the refusals. */
async function decisionsOf(root: string, sessionID: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(join(root, '.openagentsy', 'audit.jsonl'), 'utf8');
  } catch {
    return [];
  }
  const lines: string[] = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    let entry: { sessionID?: string; action?: string; resource?: string; effect?: string };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry.sessionID !== sessionID) continue;
    lines.push(`${entry.action ?? 'action'} ${entry.resource ?? ''} ${entry.effect ?? ''}`.trim());
  }
  return lines;
}

/**
 * The packet the archivist reads.
 *
 * It names the session, the role, what the session wrote, and what it said.
 * It does not carry the transcript of another session, and it does not carry
 * the whole board.
 */
function buildPacket(input: {
  sessionID: string;
  role: string;
  agent: string;
  transcript: string;
  decisions: string[];
}): string {
  const lines = [
    `A ${input.role} session finished. Its id is ${input.sessionID} and the agent was ${input.agent}.`,
    '',
    'What it did, in the order it did it:',
    ...(input.decisions.length > 0
      ? input.decisions.map((line) => `- ${line}`)
      : ['- nothing was recorded']),
    '',
    'What it said:',
    input.transcript.length > 0 ? input.transcript : '(it said nothing)',
    '',
    'Read the board for the records of this session if you need more.',
    'Save at most five candidate memories, each with a category, its source and a confidence.',
    'Drop what the code already says and anything you cannot point at.',
  ];
  return lines.join('\n');
}
