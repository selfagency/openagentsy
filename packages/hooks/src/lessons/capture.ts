import { redactForStorage } from '../secrets.js';
import { type Lesson, normalizeText, type Owner, type StartPacket } from './model.js';
import {
  createLessonId,
  listLessons,
  type Observation,
  readObservations,
  writeLesson,
  writeObservations,
} from './store.js';

/**
 * The capture.
 *
 * The archivist watches for the same kind of waste again and again, and it
 * turns that into a candidate. It does so in two cases only:
 *
 * - the same waste kind with a similar detail shows up in three or more
 *   sessions, which is a pattern rather than an accident;
 * - a person corrects the agent outright, which is a lesson whatever the
 *   count is.
 *
 * The observations are kept before there is a candidate, because the rule is
 * about sessions: the third session is only a pattern if the first two are
 * remembered. A candidate is deduplicated by its normalised summary, and
 * every sighting of the same summary raises the count. The count is a
 * priority, not evidence: a lesson that happened often is still only a claim
 * until a person has decided it.
 */

/** How many sessions make a pattern. */
export const SESSION_THRESHOLD = 3;

/** One waste, as the archivist saw it. */
export type WasteObservation = {
  /** The waste kind. */
  kind: string;
  /** The detail the waste carried. */
  detail: string;
  /** The session it was seen in. */
  session: string;
};

/** What the archivist saw. */
export type CaptureInput = {
  /** What happened, in one sentence. */
  summary: string;
  /** The waste, once per sighting. */
  observations: WasteObservation[];
  /** Whether a person corrected the agent outright. */
  explicitCorrection?: boolean;
  /** The evidence the lesson rests on. */
  evidence?: string[];
  /** The start packet, as far as the archivist can fill it. */
  packet?: Partial<StartPacket>;
};

/** What the capture did. */
export type CaptureOutcome =
  | { ok: true; lesson: Lesson; created: boolean; redactions: number }
  | { ok: false; reason: 'not_enough_sessions'; redactions: number; sessions: number };

/**
 * Redact every text field of a packet.
 *
 * The packet is read by a person, and it is written to disk, so it goes
 * through the same door as everything else that is stored.
 */
function redactPacket(packet: Partial<StartPacket>): {
  packet: Partial<StartPacket>;
  count: number;
} {
  let count = 0;
  const text = (value: string): string => {
    const redacted = redactForStorage(value);
    count += redacted.count;
    return redacted.text;
  };
  const list = (values: string[]): string[] =>
    values.map((value) => {
      const redacted = redactForStorage(value);
      count += redacted.count;
      return redacted.text;
    });
  const owner = packet.owner;
  const redactedOwner = owner === undefined ? undefined : text(owner);
  return {
    packet: {
      ...(packet.futureBehavior === undefined
        ? {}
        : { futureBehavior: text(packet.futureBehavior) }),
      ...(packet.representativeTask === undefined
        ? {}
        : { representativeTask: text(packet.representativeTask) }),
      ...(packet.evidence === undefined ? {} : { evidence: list(packet.evidence) }),
      ...(redactedOwner === undefined ? {} : { owner: redactedOwner as Owner }),
      ...(packet.ownerJustification === undefined
        ? {}
        : { ownerJustification: text(packet.ownerJustification) }),
      ...(packet.writeBoundary === undefined ? {} : { writeBoundary: list(packet.writeBoundary) }),
      ...(packet.proof === undefined ? {} : { proof: text(packet.proof) }),
    },
    count,
  };
}

/**
 * The key a waste is counted under.
 *
 * The kind and the normalised detail make the key, so a waste that says the
 * same thing twice is one waste, and a waste of another kind is another one.
 */
function groupKey(observation: Observation): string {
  return `${observation.kind} ${normalizeText(observation.detail)}`;
}

/** A group of waste, and the sessions it was seen in. */
type Group = {
  kind: string;
  detail: string;
  sessions: Set<string>;
};

/**
 * The groups of waste, and the sessions each was seen in.
 */
function groupsOf(observations: Observation[]): Map<string, Group> {
  const groups = new Map<string, Group>();
  for (const observation of observations) {
    const key = groupKey(observation);
    const group = groups.get(key) ?? {
      kind: observation.kind,
      detail: observation.detail,
      sessions: new Set<string>(),
    };
    group.sessions.add(observation.session);
    groups.set(key, group);
  }
  return groups;
}

/**
 * Capture a lesson.
 *
 * Nothing is written to the lesson store until there is something to write:
 * a waste that has been seen once is not a pattern, and the archivist says
 * so instead of filling the store with candidates nobody will read. The
 * observations are kept either way, because the third session is only a
 * pattern if the first two are remembered.
 */
export async function captureCandidate(
  root: string,
  input: CaptureInput,
  now: () => Date = () => new Date(),
): Promise<CaptureOutcome> {
  const summary = redactForStorage(input.summary);
  const evidence = (input.evidence ?? []).map((entry) => redactForStorage(entry));
  const packet = redactPacket(input.packet ?? {});

  let redactions = summary.count + packet.count;
  const observations: Observation[] = input.observations.map((observation) => {
    const kind = redactForStorage(observation.kind);
    const detail = redactForStorage(observation.detail);
    redactions += kind.count + detail.count;
    return { kind: kind.text, detail: detail.text, session: observation.session };
  });
  redactions += evidence.reduce((total, entry) => total + entry.count, 0);

  const history = await readObservations(root);
  const all = [...history, ...observations];
  await writeObservations(root, all);

  let best: Group = { kind: '', detail: '', sessions: new Set<string>() };
  const incoming = new Set(observations.map(groupKey));
  for (const [key, group] of groupsOf(all)) {
    // Only the waste that was just seen decides: an older pattern does not
    // make a new sighting a candidate.
    if (!incoming.has(key)) continue;
    if (group.sessions.size > best.sessions.size) best = group;
  }

  const stamp = now().toISOString();
  const key = normalizeText(summary.text);
  const existing = (await listLessons(root)).find(
    (lesson) => normalizeText(lesson.summary) === key,
  );

  if (existing !== undefined) {
    const lesson: Lesson = {
      ...existing,
      occurrences: existing.occurrences + 1,
      sessions: [...new Set([...existing.sessions, ...best.sessions])],
      packet: { ...existing.packet, ...packet.packet },
      updated_at: stamp,
    };
    await writeLesson(root, lesson);
    return { ok: true, lesson, created: false, redactions };
  }

  const explicit = input.explicitCorrection === true;
  if (!explicit && best.sessions.size < SESSION_THRESHOLD) {
    return {
      ok: false,
      reason: 'not_enough_sessions',
      redactions,
      sessions: best.sessions.size,
    };
  }

  const lesson: Lesson = {
    id: createLessonId(),
    state: 'candidate',
    summary: summary.text,
    occurrences: 1,
    packet: packet.packet,
    history: [],
    kind: best.kind,
    detail: best.detail,
    sessions: [...best.sessions],
    created_at: stamp,
    updated_at: stamp,
  };
  await writeLesson(root, lesson);
  return { ok: true, lesson, created: true, redactions };
}
