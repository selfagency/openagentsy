import { createReadStream, type ReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { appendAudit, POLICIES } from './guard.js';

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

/**
 * Whether the memory pipeline runs for this project.
 *
 * The harvest is a real agent run per finished session, and it costs a
 * provider call each time. A project that does not want the memories can
 * say so: a file named `.openagentsy/harvest` with the word `off` turns it
 * off, and anything else leaves it on. A pipeline that stops on a typo
 * loses memories silently, so only the word `off` stops it.
 */
export async function harvestEnabled(root: string): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(join(root, '.openagentsy', 'harvest'), 'utf8');
  } catch {
    return true;
  }
  return text.trim().toLowerCase() !== 'off';
}

/**
 * The three things a harvest needs from a session runtime.
 *
 * The two runtimes speak differently: the V1 path talks to the server client
 * and the V2 path talks to the plugin context. The harvest only needs to
 * read a transcript, open a session and hand it a packet, so that is what it
 * asks for.
 */
export type HarvestSession = {
  /** The messages of a session, in the order they were said. */
  messages: (sessionID: string) => Promise<{ parts?: { type: string; text?: string }[] }[]>;
  /**
   * Open a session for the archivist, as a child of the session it harvests.
   *
   * It is a working session, not a chapter of the person's history, and a
   * child session keeps it out of the top level list.
   */
  create: (input: { title: string; parentID: string }) => Promise<string | undefined>;
  /** Hand the archivist its packet. */
  prompt: (input: { sessionID: string; agent: string; text: string }) => Promise<void>;
};

export type HarvestInput = {
  session: HarvestSession;
  root: string;
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
  const { session, root, sessionID, role, agent } = input;
  if (NOT_HARVESTED.has(role)) {
    return { harvested: false, reason: `${role} sessions are not harvested` };
  }

  const messages = await session.messages(sessionID);
  const transcript = transcriptOf(messages);
  const decisions = await decisionsOf(root, sessionID);

  // Nothing new means nothing to keep: no writes, no refusals, no words.
  if (transcript.length === 0 && decisions.length === 0) {
    return { harvested: false, reason: 'the session left nothing behind' };
  }

  const packet = buildPacket({ sessionID, role, agent, transcript, decisions });

  const archivistSession = await session.create({
    title: `harvest ${role}`,
    parentID: sessionID,
  });
  if (archivistSession === undefined) {
    return { harvested: false, reason: 'the server created no session for the archivist' };
  }

  await session.prompt({ sessionID: archivistSession, agent: ARCHIVIST, text: packet });

  return { harvested: true, reason: `the archivist was given the packet of ${sessionID}` };
}

/**
 * A harvest that failed, on the record.
 *
 * The failure is put on the record rather than thrown, because a harvest
 * that fails must not break the session that is closing. Both runtimes do
 * this the same way.
 */
export async function recordHarvestFailure(
  root: string,
  input: { agent: string; sessionID: string; error: unknown },
): Promise<void> {
  await appendAudit(root, {
    policyId: POLICIES.harvestFailed.id,
    policyVersion: POLICIES.harvestFailed.version,
    actor: input.agent,
    action: 'harvest',
    resource: input.sessionID,
    effect: 'deny',
    detail: input.error instanceof Error ? input.error.message : String(input.error),
  });
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
  const path = join(root, '.openagentsy', 'audit.jsonl');
  const lines: string[] = [];
  // The audit log grows for as long as the board lives, and it is read at
  // every session end, so it is read a line at a time.
  let handle: ReadStream | undefined;
  try {
    handle = createReadStream(path, { encoding: 'utf8' });
    const linesOf = createInterface({ input: handle, crlfDelay: Infinity });
    for await (const line of linesOf) {
      if (line.trim().length === 0) continue;
      let entry: { sessionID?: string; action?: string; resource?: string; effect?: string };
      try {
        entry = JSON.parse(line) as typeof entry;
      } catch {
        continue;
      }
      if (entry.sessionID !== sessionID) continue;
      lines.push(
        `${entry.action ?? 'action'} ${entry.resource ?? ''} ${entry.effect ?? ''}`.trim(),
      );
    }
  } catch {
    return lines;
  } finally {
    handle?.close();
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
    'Post at most five candidate memories as board records with',
    'openagentsy_board_record: kind finding, addressed to the Lead, bean',
    'memory, the candidate in the action, its category and source (bean,',
    'commit, file:line) in the state, and a confidence of verified, inferred',
    'or guess. A candidate that is not posted is lost.',
    'Drop what the code already says and anything you cannot point at.',
  ];
  return lines.join('\n');
}
