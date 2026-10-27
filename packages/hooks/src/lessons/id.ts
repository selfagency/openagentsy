import { randomUUID } from 'node:crypto';

/**
 * The identity of a lesson.
 *
 * The id is checked before a path is built from it, because the id comes
 * from a tool argument and a path is not an argument to trust: an id that
 * names a directory above the state root would write the file somewhere else.
 * The grammar is therefore narrow on purpose - a prefix, a dash, and letters
 * and digits.
 */
const LESSON_ID = /^oa-lesson-[a-z0-9]{4,32}$/;

/** Whether a value is a lesson id. */
export function isLessonId(value: unknown): value is string {
  return typeof value === 'string' && LESSON_ID.test(value);
}

/** A new lesson id. */
export function createLessonId(): string {
  return `oa-lesson-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}
