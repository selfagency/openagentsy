import { PRIORITIES, STATUSES, type Task, TERMINAL } from './model.js';

/**
 * The questions the store is asked about the tasks.
 *
 * A task is not ready because its own status says so: it is ready because
 * nothing is in front of it. A task whose parent is blocked is blocked, a
 * task under a finished parent is finished, and the two facts travel up the
 * parent chain, which is what the index below walks.
 */

/** The order the statuses sort in. */
const STATUS_RANK = new Map(STATUSES.map((status, rank) => [status, rank]));

/** The order the priorities sort in. */
const PRIO_RANK = new Map(PRIORITIES.map((priority, rank) => [priority, rank]));

/** The tasks, indexed for the questions. */
export interface TaskIndex {
  /** Every task, by id. */
  byId: Map<string, Task>;
  /** Whether a task is blocked, directly or through a parent. */
  isBlocked: (task: Task) => boolean;
  /** Whether a task is finished, directly or through a parent. */
  effectiveTerminal: (task: Task) => boolean;
  /** The parents of a task, nearest first. */
  ancestors: (task: Task) => Task[];
}

/**
 * The index the queries run on.
 *
 * The blockers map holds, for every task, the tasks that hold it up: the
 * ones it names as blockers, and the ones that name it as blocked. A
 * blocker that is finished holds nothing up.
 */
export function index(tasks: Task[]): TaskIndex {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const blockers = new Map<string, Set<string>>();

  const hold = (task: string, blocker: string): void => {
    const held = blockers.get(task) ?? new Set<string>();
    held.add(blocker);
    blockers.set(task, held);
  };

  for (const task of tasks) {
    for (const blocker of task.blocked_by ?? []) hold(task.id, blocker);
    for (const blocked of task.blocking ?? []) hold(blocked, task.id);
  }

  const ancestors = (task: Task): Task[] => {
    const out: Task[] = [];
    const seen = new Set<string>();
    let parent = task.parent ? byId.get(task.parent) : undefined;
    while (parent && !seen.has(parent.id)) {
      seen.add(parent.id);
      out.push(parent);
      parent = parent.parent ? byId.get(parent.parent) : undefined;
    }
    return out;
  };

  const directlyBlocked = (task: Task): boolean =>
    [...(blockers.get(task.id) ?? [])].some((id) => {
      const blocker = byId.get(id);
      return blocker !== undefined && !TERMINAL.has(blocker.status);
    });

  const isBlocked = (task: Task): boolean =>
    directlyBlocked(task) || ancestors(task).some(directlyBlocked);

  const effectiveTerminal = (task: Task): boolean =>
    TERMINAL.has(task.status) || ancestors(task).some((parent) => TERMINAL.has(parent.status));

  return { byId, isBlocked, effectiveTerminal, ancestors };
}

/**
 * The order tasks are shown in.
 *
 * The status first, then the priority, then the manual order, and the
 * creation time last, so the order is stable for tasks that say nothing
 * else about themselves.
 */
export const sortTasks = (a: Task, b: Task): number =>
  rank(STATUS_RANK, a.status) - rank(STATUS_RANK, b.status) ||
  rank(PRIO_RANK, a.priority ?? 'normal') - rank(PRIO_RANK, b.priority ?? 'normal') ||
  compare(a.order ?? '', b.order ?? '') ||
  compare(a.created_at ?? '', b.created_at ?? '');

/**
 * The tasks that can be picked up now.
 *
 * A task is ready when it is a todo, when it is not a container, when
 * nothing holds it up, and when nothing above it is finished. A paused task
 * is not a todo, so it is not ready: somebody put it down on purpose.
 */
export function ready(tasks: Task[]): Task[] {
  const ix = index(tasks);
  return tasks
    .filter(
      (task) =>
        task.status === 'todo' &&
        task.type !== 'epic' &&
        task.type !== 'milestone' &&
        !ix.isBlocked(task) &&
        !ix.effectiveTerminal(task),
    )
    .sort(sortTasks);
}

/** The task that should be picked up next. */
export const next = (tasks: Task[]): Task | undefined => ready(tasks)[0];

/** The rank of a value, with the unknown ones last. */
const rank = <T>(ranks: Map<T, number>, value: T): number => ranks.get(value) ?? ranks.size;

/**
 * The order of two texts.
 *
 * The comparison is by code unit and not by locale. An order key is a
 * base-62 string, and the fractional index puts one key between two
 * others by code unit; a locale would sort the upper case letters after
 * the lower case ones, which is a different order than the index means.
 */
const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
