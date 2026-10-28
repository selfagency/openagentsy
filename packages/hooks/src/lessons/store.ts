import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { redactForStorage } from '../secrets.js';
import { isLessonId } from './id.js';
import { type Lesson, LessonError, type StartPacket } from './model.js';

export { createLessonId, isLessonId } from './id.js';

/**
 * The lesson store.
 *
 * A lesson is a file: `.openagentsy/lessons/<id>.json`. The path is a
 * protected one, because a lesson is a decision and a decision is a person's
 * to make. The file is written with mode 0600 for the same reason.
 */

/** The directory the lessons live in. */
export function lessonsDir(root: string): string {
  return join(root, '.openagentsy', 'lessons');
}

/**
 * The file a lesson lives in.
 */
export function lessonPath(root: string, id: string): string {
  if (!isLessonId(id)) {
    throw new LessonError(
      `"${id}" is not a lesson id`,
      'a lesson id looks like oa-lesson-abcd1234',
    );
  }
  return join(lessonsDir(root), `${id}.json`);
}

/**
 * A string, redacted.
 */
function redacted(value: string): string {
  return redactForStorage(value).text;
}

/**
 * A list of strings, redacted.
 */
function redactedList(values: string[]): string[] {
  return values.map(redacted);
}

/**
 * The packet, redacted.
 */
function redactedPacket(packet: Partial<StartPacket>): Partial<StartPacket> {
  return {
    ...packet,
    ...(packet.futureBehavior === undefined
      ? {}
      : { futureBehavior: redacted(packet.futureBehavior) }),
    ...(packet.representativeTask === undefined
      ? {}
      : { representativeTask: redacted(packet.representativeTask) }),
    ...(packet.evidence === undefined ? {} : { evidence: redactedList(packet.evidence) }),
    ...(packet.owner === undefined
      ? {}
      : { owner: redacted(packet.owner) as StartPacket['owner'] }),
    ...(packet.ownerJustification === undefined
      ? {}
      : { ownerJustification: redacted(packet.ownerJustification) }),
    ...(packet.writeBoundary === undefined
      ? {}
      : { writeBoundary: redactedList(packet.writeBoundary) }),
    ...(packet.proof === undefined ? {} : { proof: redacted(packet.proof) }),
  };
}

/**
 * The lesson, redacted.
 *
 * The write is the door every string goes through, not only the ones the
 * capture filled in. A person pastes a token into the reason of a decision
 * and into the id of a session, and neither may survive on the disk.
 */
function redactedLesson(lesson: Lesson): Lesson {
  return {
    ...lesson,
    summary: redacted(lesson.summary),
    kind: redacted(lesson.kind),
    detail: redacted(lesson.detail),
    sessions: redactedList(lesson.sessions),
    packet: redactedPacket(lesson.packet),
    history: lesson.history.map((entry) => ({
      ...entry,
      decidedBy: redacted(entry.decidedBy),
      reason: redacted(entry.reason),
      ...(entry.changeRef === undefined ? {} : { changeRef: redacted(entry.changeRef) }),
    })),
  };
}

/**
 * Write a lesson.
 *
 * The write is atomic in the sense that matters here: the file is written
 * whole or not at all, and it is never written over another lesson, because
 * the id is in the name.
 */
export async function writeLesson(root: string, lesson: Lesson): Promise<string> {
  const path = lessonPath(root, lesson.id);
  await mkdir(lessonsDir(root), { recursive: true });
  await writeFile(path, `${JSON.stringify(redactedLesson(lesson), null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await chmod(path, 0o600);
  return path;
}

/**
 * Read a lesson.
 *
 * A lesson that is not there is not an error: the caller asks about a lesson
 * that may not exist, and gets nothing.
 */
export async function readLesson(root: string, id: string): Promise<Lesson | undefined> {
  if (!isLessonId(id)) return undefined;
  let text: string;
  try {
    text = await readFile(lessonPath(root, id), 'utf8');
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text) as Lesson;
  } catch {
    return undefined;
  }
}

/**
 * Every lesson, in the order the inbox shows them.
 *
 * The count comes first, because a lesson that happened more often is more
 * worth a person's time, and the recency breaks a tie, because the newest of
 * two equals is the one that is still true.
 */
export function sortInbox(lessons: Lesson[]): Lesson[] {
  return [...lessons].sort((a, b) => {
    if (a.occurrences !== b.occurrences) return b.occurrences - a.occurrences;
    if (a.updated_at !== b.updated_at) return a.updated_at < b.updated_at ? 1 : -1;
    return a.id.localeCompare(b.id);
  });
}

/** The states a lesson never leaves. */
const FINAL_STATES = new Set(['rejected', 'superseded', 'rolled_back', 'no_delta']);

/**
 * The lessons that are still waiting for a person.
 */
export function pendingLessons(lessons: Lesson[]): Lesson[] {
  return sortInbox(lessons.filter((lesson) => !FINAL_STATES.has(lesson.state)));
}

/**
 * Every lesson the store holds.
 */
export async function listLessons(root: string): Promise<Lesson[]> {
  let names: string[];
  try {
    names = await readdir(lessonsDir(root));
  } catch {
    return [];
  }
  const lessons: Lesson[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    if (!isLessonId(id)) continue;
    const lesson = await readLesson(root, id);
    if (lesson !== undefined) lessons.push(lesson);
  }
  return sortInbox(lessons);
}

/**
 * One waste, as the archivist saw it.
 *
 * The observations are kept before there is a candidate, because the rule
 * that makes a candidate is about sessions: the third session only counts if
 * the first two are still there.
 */
export type Observation = {
  kind: string;
  detail: string;
  session: string;
};

/** The most observations the store keeps. The oldest go first. */
export const MAX_OBSERVATIONS = 500;

/** The file the observations live in. */
export function observationsPath(root: string): string {
  return join(lessonsDir(root), 'observations.json');
}

/**
 * Whether a value is an observation.
 */
function isObservation(value: unknown): value is Observation {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.kind === 'string' &&
    typeof entry.detail === 'string' &&
    typeof entry.session === 'string'
  );
}

/**
 * Every observation the archivist made.
 */
export async function readObservations(root: string): Promise<Observation[]> {
  let text: string;
  try {
    text = await readFile(observationsPath(root), 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isObservation);
}

/**
 * Keep the observations.
 *
 * The file is capped, because the archivist runs at the end of every
 * session and the older sightings are worth less than the newer ones.
 */
export async function writeObservations(root: string, observations: Observation[]): Promise<void> {
  await mkdir(lessonsDir(root), { recursive: true });
  const path = observationsPath(root);
  const kept = observations.slice(-MAX_OBSERVATIONS).map((observation) => ({
    kind: redacted(observation.kind),
    detail: redacted(observation.detail),
    session: redacted(observation.session),
  }));
  await writeFile(path, `${JSON.stringify(kept, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600);
}
