/**
 * The task model: the vocabulary every other module in this package speaks.
 *
 * The statuses, types and priorities are Beans' lists, unchanged and in the
 * same order, because the files are Beans' files: a store that renamed
 * `in-progress` would refuse to read half the tasks a person already has.
 * The one addition is `paused`, which says a task was started and then
 * deliberately put down — still open, but nobody is on it.
 */

/** Every status a task can carry, in the order the lists are sorted by. */
export const STATUSES = [
  'in-progress',
  'todo',
  'draft',
  'completed',
  'scrapped',
  'paused',
] as const;

export type Status = (typeof STATUSES)[number];

/** The statuses a task never leaves. */
export const TERMINAL: ReadonlySet<Status> = new Set<Status>(['completed', 'scrapped']);

/** The kinds of work a task can be. An epic and a milestone hold other tasks. */
export const TYPES = ['milestone', 'epic', 'bug', 'feature', 'task'] as const;

export type TaskType = (typeof TYPES)[number];

/** The priorities, most urgent first. */
export const PRIORITIES = ['critical', 'high', 'normal', 'low', 'deferred'] as const;

export type Priority = (typeof PRIORITIES)[number];

/**
 * A task, as the store sees it.
 *
 * The id and the slug come from the file name, the rest from the front
 * matter, the body from what follows it. The etag is the hash of the file's
 * bytes, so it is the same whoever wrote the file.
 */
export interface Task {
  /** From the file name, for example `oa-4f2k`. */
  id: string;
  /** From the file name, for example `fix-footprint-ranges`. */
  slug: string;
  /** Relative to the store's root, for example `oa-4f2k--fix-footprint.md`. */
  path: string;
  title: string;
  status: Status;
  type?: TaskType;
  priority?: Priority;
  tags?: string[];
  /** ISO 8601. */
  created_at?: string;
  /** ISO 8601. */
  updated_at?: string;
  /** The fractional order key. */
  order?: string;
  /** The id of the task this one hangs under. */
  parent?: string;
  /** The ids of the tasks this one blocks. */
  blocking?: string[];
  /** The ids of the tasks that block this one. */
  blocked_by?: string[];
  body: string;
  /** fnv1a64 of the file's bytes. */
  etag: string;
}

/**
 * The tag grammar: lowercase, starts with a letter, and the hyphens never
 * double and never trail. The same rule Beans applies, so a tag written by
 * one store is a tag the other accepts.
 */
const TAG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Whether a tag is well formed. */
export const validateTag = (tag: string): boolean => TAG.test(tag);

/** Whether a string is one of the known statuses. */
export const isStatus = (value: unknown): value is Status =>
  typeof value === 'string' && (STATUSES as readonly string[]).includes(value);

/** Whether a string is one of the known types. */
export const isTaskType = (value: unknown): value is TaskType =>
  typeof value === 'string' && (TYPES as readonly string[]).includes(value);

/** Whether a string is one of the known priorities. */
export const isPriority = (value: unknown): value is Priority =>
  typeof value === 'string' && (PRIORITIES as readonly string[]).includes(value);
