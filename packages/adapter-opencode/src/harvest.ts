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

/** How long a harvest child is kept. Older children are pruned. */
const HARVEST_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Whether the memory pipeline runs for this project.
 *
 * The harvest is a real agent run per finished session, and it costs a
 * provider call each time. A project that does not want the memories can
 * say so: a file named `.openagentsy/harvest` with the word `off` turns it
 * off, and anything else leaves it on. A pipeline that stops on a typo
 * loses memories silently, so only the word `off` stops it.
 */
export async function harvestEnabled(stateRoot: string): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(join(stateRoot, '.openagentsy', 'harvest'), 'utf8');
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
   * Open a session for the archivist.
   *
   * It is a working session, not part of the person's history, and its
   * title is what the janitor reads, so the janitor finds it whether or not
   * a parent links it to the session that is ending. No parent is passed:
   * a child of the harvested session dies when the server deletes that
   * session, which is a delete the server does without asking.
   */
  create: (input: { title: string; parentID?: string }) => Promise<string | undefined>;
  /** Hand the archivist its packet. */
  prompt: (input: { sessionID: string; agent: string; text: string }) => Promise<void>;
  /**
   * Whether a session still exists, asked of the server.
   *
   * It is optional. A runtime that cannot look a session up leaves it out,
   * and the harvest then prompts the archivist without the check. The check
   * exists because the archivist used to be created as a child of the
   * session that is ending: when that session was deleted the child went
   * with it, and the message insert failed the foreign key instead of
   * reaching the archivist. The archivist now stands on its own, so the
   * check is a guard and not a requirement, and a runtime with no lookup to
   * ask does not have to fake one.
   *
   * A message list cannot answer this: a session that exists and has not
   * been spoken in yet and a session that was deleted both answer with no
   * messages, so an empty list proves neither. A runtime that has a lookup
   * must use it, and a runtime that cannot answer must say so rather than
   * leave the harvest to guess: a lookup that throws is a failure on the
   * record, not a prompt.
   */
  exists?: (sessionID: string) => Promise<boolean>;
  /**
   * Delete the harvest children the janitor owns.
   *
   * Optional: a runtime that cannot list and delete sessions leaves it out,
   * and the harvest then does not prune. When it is present the harvest only
   * starts it: it is never awaited, so a slow list or a refused delete
   * cannot delay or fail the harvest of this session.
   */
  prune?: () => Promise<void>;
};

export type HarvestInput = {
  session: HarvestSession;
  /** The state root: the audit log the decisions are read from lives there. */
  stateRoot: string;
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
  const { session, stateRoot, sessionID, role, agent } = input;
  if (NOT_HARVESTED.has(role)) {
    return { harvested: false, reason: `${role} sessions are not harvested` };
  }

  const messages = await session.messages(sessionID);
  const transcript = transcriptOf(messages);
  const decisions = await decisionsOf(stateRoot, sessionID);

  // Nothing new means nothing to keep: no writes, no refusals, no words.
  if (transcript.length === 0 && decisions.length === 0) {
    return { harvested: false, reason: 'the session left nothing behind' };
  }

  const packet = buildPacket({ sessionID, role, agent, transcript, decisions });

  // The archivist stands on its own, not as a child of the session it
  // harvests. A child of that session dies with it: the server deletes a
  // session row without asking, and the delete cascades into the child,
  // which cost the archivist's work twice while this ran as a child. The
  // packet carries what it needs, so no parent link is missed, and the
  // janitor finds the sessions by their title, not by their parent.
  let archivistSession: string | undefined;
  try {
    archivistSession = await session.create({
      title: `harvest ${role}`,
    });
  } catch (error) {
    const failure =
      error instanceof Error
        ? error
        : new Error('the server refused to create the archivist session');
    await recordHarvestFailure(stateRoot, { agent, sessionID, error: failure });
    return { harvested: false, reason: failure.message };
  }
  if (archivistSession === undefined) {
    return { harvested: false, reason: 'the server created no session for the archivist' };
  }

  // The child was just created, but the session it hangs from can be deleted
  // while the archivist works: the delete cascades to the child, and the next
  // message insert fails the foreign key instead of reaching the archivist.
  // An empty message list is not proof the child is gone (a fresh session has
  // none either), so the server is asked for the row itself.
  //
  // A runtime that cannot answer is never guessed at: prompting a session
  // that may be gone is the failure this check exists to prevent. A lookup
  // that throws is a failure on the record, not a prompt. A runtime with no
  // lookup at all is a runtime that says so, and the harvest goes on: the
  // archivist stands on its own and the cascade it guarded against does not
  // happen.
  const promptable = await mayPrompt(session, archivistSession);
  if (!promptable.ok) {
    const error = new Error(promptable.reason);
    await recordHarvestFailure(stateRoot, { agent, sessionID, error });
    return { harvested: false, reason: error.message };
  }

  try {
    await session.prompt({ sessionID: archivistSession, agent: ARCHIVIST, text: packet });
  } catch (error) {
    const failure =
      error instanceof Error ? error : new Error('the archivist could not be prompted');
    await recordHarvestFailure(stateRoot, { agent, sessionID, error: failure });
    return { harvested: false, reason: failure.message };
  }

  // The janitor runs beside the harvest, not inside it: it is started here
  // and never awaited, so the session that is closing is not held while the
  // server lists and deletes old children. It records its own failure, so it
  // cannot throw into the harvest, and the result below is what the harvest
  // did regardless of what the prune does. The catch is for a runtime whose
  // prune rejects anyway, so an unhandled rejection cannot reach the
  // closing session.
  const pruning = session.prune?.();
  if (pruning !== undefined) void pruning.catch(() => {});

  return { harvested: true, reason: `the archivist was given the packet of ${sessionID}` };
}

/**
 * The answer of the lookup: the harvest may go on, or it may not.
 */
type PromptCheck = { ok: true } | { ok: false; reason: string };

/**
 * Whether the harvest may prompt the archivist.
 *
 * A runtime with no lookup to ask says so by leaving the lookup out, and
 * the harvest goes on: the archivist stands on its own, so the cascade the
 * lookup guarded against does not happen. A lookup that says the session is
 * gone is the same end state: the prompt would fail instead of reaching the
 * archivist. A lookup that throws is a failure on the record, not a prompt.
 */
async function mayPrompt(session: HarvestSession, sessionID: string): Promise<PromptCheck> {
  if (session.exists === undefined) return { ok: true };
  try {
    if (await session.exists(sessionID)) return { ok: true };
    return { ok: false, reason: `the archivist session ${sessionID} no longer exists` };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof Error
          ? error.message
          : 'the runtime cannot confirm that a session still exists',
    };
  }
}

/**
 * A harvest that failed, on the record.
 *
 * The failure is put on the record rather than thrown, because a harvest
 * that fails must not break the session that is closing. Both runtimes do
 * this the same way.
 */
export async function recordHarvestFailure(
  stateRoot: string,
  input: { agent: string; sessionID: string; error: unknown },
): Promise<void> {
  await appendAudit(stateRoot, {
    policyId: POLICIES.harvestFailed.id,
    policyVersion: POLICIES.harvestFailed.version,
    actor: input.agent,
    action: 'harvest',
    resource: input.sessionID,
    effect: 'deny',
    detail: input.error instanceof Error ? input.error.message : String(input.error),
  });
}

/** One session as the janitor reads it. */
export type PruneSessionRow = {
  id?: string;
  title?: string;
  agent?: string;
  time?: { created?: number; updated?: number };
};

/** The two operations the janitor needs from a session runtime. */
export type PruneSession = {
  list: () => Promise<PruneSessionRow[]>;
  delete: (sessionID: string) => Promise<void>;
};

/**
 * Delete the harvest children that are older than seven days.
 *
 * The rule is deliberately this narrow, because this is the one place the
 * plugin deletes a session, and a session it did not create can hold a
 * person's own history. A row is ours only when every condition holds:
 *
 * - the title starts with `harvest `, the prefix `harvest()` writes;
 * - the agent is `oa-archivist`, the only agent a harvest child runs under;
 * - it was created more than seven days ago.
 *
 * A recent child is kept even though it is ours: the archivist may still be
 * working in it, and a week is long enough for its candidates to reach the
 * board. A row the runtime gives without an agent or a creation time is kept
 * too, because the rule is a conjunction and a condition that cannot be
 * checked is not a pass; the older rows with an empty agent are exactly this
 * case, and they are left alone.
 *
 * It never rejects: every failure is written the way a failed harvest is,
 * and the next row is still tried. A delete of a row the server no longer
 * has is handled by the runtime adapter as a no-op, because a second delete
 * asks for the same end state as the first.
 */
export async function pruneHarvestChildren(
  session: PruneSession,
  stateRoot: string,
  now: number = Date.now(),
): Promise<void> {
  let rows: PruneSessionRow[];
  try {
    rows = await session.list();
  } catch (error) {
    await recordHarvestPruneFailure(stateRoot, '(session list)', error);
    return;
  }

  for (const row of rows) {
    if (!isStaleHarvestChild(row, now)) continue;
    const sessionID = row.id;
    if (sessionID === undefined) continue;
    try {
      await session.delete(sessionID);
    } catch (error) {
      // One refused delete must not stop the sweep, and it must not reach
      // the harvest. It goes on the record like any other harvest failure.
      await recordHarvestPruneFailure(stateRoot, sessionID, error);
    }
  }
}

/** Whether a row is one of the harvest's own children and is past its keep. */
function isStaleHarvestChild(row: PruneSessionRow, now: number): boolean {
  if (row.title === undefined || !row.title.startsWith('harvest ')) return false;
  // The server may omit the agent (the V1 SDK type does not carry it). An
  // unreported agent is not a match: the condition is unverified, so keep it.
  if (row.agent !== ARCHIVIST) return false;
  const created = row.time?.created;
  if (created === undefined) return false;
  return now - created > HARVEST_RETENTION_MS;
}

/**
 * A failed prune, on the record.
 *
 * It is recorded as a harvest failure, because that is the policy the
 * janitor acts under. Recording can itself fail (an unwritable state root);
 * there is nowhere left to put that, and the prune must not reject into the
 * harvest it runs beside, so it is dropped.
 */
async function recordHarvestPruneFailure(
  stateRoot: string,
  sessionID: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  try {
    await recordHarvestFailure(stateRoot, {
      agent: ARCHIVIST,
      sessionID,
      error: new Error(`harvest prune failed: ${message}`),
    });
  } catch {
    // Nowhere left to record it. The prune stays silent rather than reject.
  }
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
async function decisionsOf(stateRoot: string, sessionID: string): Promise<string[]> {
  const path = join(stateRoot, '.openagentsy', 'audit.jsonl');
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
