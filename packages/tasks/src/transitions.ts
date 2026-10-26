import { type Status, type Task, validateTag } from './model.js';

/**
 * The rules the code enforces, so the prompts do not have to.
 *
 * A task is a shared document: one agent writes it, another reads it, and
 * both have to agree on what the file means. The rules therefore live in
 * code, next to the store, and a change that breaks one is refused with a
 * reason rather than written and hoped for.
 */

/**
 * The statuses a task may move to, per status.
 *
 * A task that is done is done: nothing comes out of `completed` or
 * `scrapped`. A task that was put down may be picked up again. A task that
 * was never started may be drafted, started, put down or scrapped.
 */
export const VALID_TRANSITIONS: Record<Status, readonly Status[]> = {
  todo: ['in-progress', 'draft', 'scrapped', 'paused'],
  draft: ['todo', 'in-progress', 'scrapped'],
  'in-progress': ['completed', 'scrapped', 'paused', 'todo'],
  paused: ['in-progress', 'todo', 'scrapped'],
  completed: [],
  scrapped: [],
};

/** A move the whitelist does not allow. */
export class InvalidStatusTransitionError extends Error {
  constructor(
    readonly from: Status,
    readonly to: Status,
  ) {
    super(`a task cannot move from ${from} to ${to}`);
    this.name = 'InvalidStatusTransitionError';
  }
}

/** A relation that would make a task depend on itself. */
export class CircularDependencyError extends Error {
  /** The cycle, as the ids around it, the first id repeated at the end. */
  constructor(readonly path: string[]) {
    super(`circular dependency: ${path.join(' → ')}`);
    this.name = 'CircularDependencyError';
  }
}

/** The parts of a task the content rules look at. */
export type TaskRules = Pick<Task, 'status' | 'type' | 'tags' | 'body'>;

/**
 * The rules that hold whatever a task's status is.
 *
 * A completed task says what changed, a scrapped task says why it was
 * dropped, an epic is a container and not a piece of work, and a tag is
 * well formed. These are the rules that would otherwise live in a prompt
 * and be forgotten.
 */
export function enforceContentRules(task: TaskRules): void {
  if (task.status === 'completed') {
    if (/- \[ \]/.test(task.body)) {
      throw new Error('Unchecked items remain; check them off or move them to a follow-up task.');
    }
    if (!/^## Summary of Changes/m.test(task.body)) {
      throw new Error('Add a "## Summary of Changes" section before completing.');
    }
  }
  if (task.status === 'scrapped' && !/^## Reasons for Scrapping/m.test(task.body)) {
    throw new Error('Add a "## Reasons for Scrapping" section before scrapping.');
  }
  if (task.type === 'epic' && task.status === 'in-progress') {
    throw new Error('Epics are containers; start one of their child tasks instead.');
  }
  for (const tag of task.tags ?? []) {
    if (!validateTag(tag)) throw new Error(`Invalid tag "${tag}"`);
  }
}

/**
 * The rule for a change of status.
 *
 * A task that keeps its status is not a move, so the whitelist does not
 * apply to it. A task whose current status the store does not know — a file
 * a person edited by hand — may move anywhere, because refusing every move
 * would leave the file unrepairable.
 */
export function enforceStatusTransition(current: Task, next: Task): void {
  if (current.status === next.status) return;
  const allowed = VALID_TRANSITIONS[current.status];
  if (!allowed) return;
  if (!allowed.includes(next.status)) {
    throw new InvalidStatusTransitionError(current.status, next.status);
  }
}

/**
 * The cycle in the dependency graph, if there is one.
 *
 * A task depends on its parent, on the tasks that block it, and — through
 * the tasks it blocks — on those tasks' blockers as well. A cycle in that
 * graph is a set of tasks that each wait for another, so no agent could
 * ever pick one of them up.
 */
export function findCycle(tasks: Task[]): string[] | undefined {
  const known = new Set(tasks.map((task) => task.id));
  const edges = dependencyEdges(tasks);
  const color = new Map<string, number>();
  const stack: string[] = [];

  for (const task of tasks) {
    if ((color.get(task.id) ?? WHITE) !== WHITE) continue;
    const found = visit(task.id, edges, known, color, stack);
    if (found) return found;
  }
  return undefined;
}

/** The states a task can be in while the graph is walked. */
const WHITE = 0;
const GREY = 1;
const BLACK = 2;

/**
 * The tasks every task waits for.
 *
 * A task waits for its parent, for the tasks that block it, and — through
 * the tasks it blocks — for their blockers as well. The relation is
 * written on both sides, so the second one is added here rather than while
 * the tasks are read.
 */
function dependencyEdges(tasks: Task[]): Map<string, string[]> {
  const edges = new Map<string, string[]>();
  for (const task of tasks) {
    const out: string[] = [];
    if (task.parent) out.push(task.parent);
    for (const blocker of task.blocked_by ?? []) out.push(blocker);
    edges.set(task.id, out);
  }
  for (const task of tasks) {
    for (const blocked of task.blocking ?? []) {
      const out = edges.get(blocked) ?? [];
      out.push(task.id);
      edges.set(blocked, out);
    }
  }
  return edges;
}

/**
 * The cycle the walk from one task finds.
 *
 * A task that is on the stack is one the walk is already inside, so the
 * path from it back to here is the cycle.
 */
function visit(
  id: string,
  edges: Map<string, string[]>,
  known: Set<string>,
  color: Map<string, number>,
  stack: string[],
): string[] | undefined {
  color.set(id, GREY);
  stack.push(id);
  for (const next of edges.get(id) ?? []) {
    if (!known.has(next)) continue;
    const state = color.get(next) ?? WHITE;
    if (state === GREY) {
      const start = stack.indexOf(next);
      return [...stack.slice(start), next];
    }
    if (state !== WHITE) continue;
    const found = visit(next, edges, known, color, stack);
    if (found) return found;
  }
  stack.pop();
  color.set(id, BLACK);
  return undefined;
}
