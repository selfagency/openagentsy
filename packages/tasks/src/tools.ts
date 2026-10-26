import { defineTool } from '@openagentsy/adapter-opencode';
import { z } from 'zod';
import { PRIORITIES, STATUSES, type Task, TYPES } from './model.js';
import { index, next, ready, sortTasks } from './query.js';
import { EtagMismatch, type TaskPatch, type TaskStore } from './store.js';
import { CircularDependencyError, InvalidStatusTransitionError } from './transitions.js';

/**
 * The tools a session reads and writes the tasks with.
 *
 * The list never carries a body and the show never carries more than ten
 * tasks, because a tool that returns everything is a tool that fills the
 * context. A refusal comes back as a sentence with a way out, not as a
 * stack: the caller is an agent, and it can act on a sentence.
 */

/** A tag, as the grammar in the model spells it. */
const Tag = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);

/** The change a task can be given. */
const TaskPatchSchema = z.object({
  title: z.string().min(1).optional(),
  status: z.enum(STATUSES).optional(),
  type: z.enum(TYPES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  addTags: z.array(Tag).optional(),
  removeTags: z.array(Tag).optional(),
  parent: z.string().nullable().optional(),
  addBlocking: z.array(z.string()).optional(),
  addBlockedBy: z.array(z.string()).optional(),
  removeBlocking: z.array(z.string()).optional(),
  removeBlockedBy: z.array(z.string()).optional(),
  bodyMod: z
    .object({
      replace: z.array(z.object({ old: z.string().min(1), new: z.string() })).optional(),
      append: z.string().optional(),
    })
    .optional(),
});

/** The names of the tools, in the order they are shown. */
export const taskToolNames = [
  'oa_task_list',
  'oa_task_show',
  'oa_task_create',
  'oa_task_update',
  'oa_task_next',
  'oa_task_archive',
] as const;

/**
 * The task tools, bound to a store.
 *
 * One definition each, written once: the V1 plugin and the V2 plugin both
 * build what they need from the same one.
 */
export const taskTools = (store: TaskStore) => ({
  oa_task_list: defineTool({
    description:
      'List tasks. Returns id, title, status, type, priority, parent and the blocked flag. No bodies.',
    args: z.object({
      status: z.array(z.enum(STATUSES)).optional(),
      type: z.array(z.enum(TYPES)).optional(),
      priority: z.array(z.enum(PRIORITIES)).optional(),
      tag: z.array(z.string()).optional(),
      parent: z.string().optional(),
      ready: z.boolean().optional(),
      search: z.string().optional(),
      limit: z.number().int().min(1).max(200).default(50),
    }),
    async execute(args) {
      return withHint('Listing the tasks', async () => {
        const tasks = await store.all();
        const ix = index(tasks);
        const open = args.ready === true ? ready(tasks) : undefined;
        const rows = tasks
          .filter((task) => matches(task, args, open))
          .sort(sortTasks)
          .slice(0, args.limit)
          .map((task) => slim(task, ix.isBlocked(task)));
        return { count: rows.length, tasks: rows };
      });
    },
  }),

  oa_task_show: defineTool({
    description: 'Full task(s) including body, etag, children and blockers.',
    args: z.object({ ids: z.array(z.string()).min(1).max(10) }),
    async execute({ ids }) {
      return withHint('Reading the tasks', async () => {
        const tasks = await store.all();
        const byId = new Map(tasks.map((task) => [task.id, task]));
        const found = [];
        const missing = [];
        for (const id of ids) {
          const task = await store.get(id);
          if (!task) {
            missing.push(id);
            continue;
          }
          const children = tasks
            .filter((candidate) => candidate.parent === id)
            .map((candidate) => ({
              id: candidate.id,
              title: candidate.title,
              status: candidate.status,
            }));
          const blockers = (task.blocked_by ?? [])
            .map((blocker) => byId.get(blocker))
            .filter((blocker): blocker is Task => blocker !== undefined)
            .map((blocker) => ({
              id: blocker.id,
              title: blocker.title,
              status: blocker.status,
            }));
          found.push({
            id: task.id,
            title: task.title,
            status: task.status,
            type: task.type ?? 'task',
            priority: task.priority ?? 'normal',
            tags: task.tags ?? [],
            created_at: task.created_at ?? null,
            updated_at: task.updated_at ?? null,
            order: task.order ?? null,
            parent: task.parent ?? null,
            blocking: task.blocking ?? [],
            blocked_by: task.blocked_by ?? [],
            body: task.body,
            etag: task.etag,
            children,
            blockers,
          });
        }
        return { tasks: found, missing };
      });
    },
  }),

  oa_task_create: defineTool({
    description: 'Create a task. Always give a type. Prefer blocked_by for dependent work.',
    args: z.object({
      title: z.string().min(3),
      type: z.enum(TYPES),
      status: z.enum(STATUSES).default('todo'),
      priority: z.enum(PRIORITIES).optional(),
      body: z.string().optional(),
      parent: z.string().optional(),
      blocked_by: z.array(z.string()).optional(),
      tags: z.array(Tag).optional(),
    }),
    async execute(args) {
      return withHint('Creating the task', async () => {
        const task = await store.create(args);
        return { id: task.id, path: task.path, status: task.status, etag: task.etag };
      });
    },
  }),

  oa_task_update: defineTool({
    description:
      'Update metadata and/or body. Pass if_match (etag) to avoid clobbering concurrent edits.',
    args: z.object({
      id: z.string(),
      if_match: z.string().optional(),
      patch: TaskPatchSchema,
    }),
    async execute({ id, if_match, patch }) {
      return withHint(`Updating ${id}`, async () => {
        const task = await store.update(id, patch as TaskPatch, if_match);
        return { id: task.id, status: task.status, etag: task.etag, updated_at: task.updated_at };
      });
    },
  }),

  oa_task_next: defineTool({
    description: 'The single highest-priority ready task, with body.',
    args: z.object({}),
    async execute() {
      return withHint('Finding the next task', async () => {
        const task = next(await store.all());
        if (!task) return { none: true, hint: 'Nothing ready; check blocked tasks.' };
        return {
          id: task.id,
          title: task.title,
          status: task.status,
          type: task.type ?? 'task',
          priority: task.priority ?? 'normal',
          body: task.body,
          etag: task.etag,
        };
      });
    },
  }),

  oa_task_archive: defineTool({
    description: 'Move completed/scrapped tasks to .beans/archive/. Only when the user asks.',
    args: z.object({ confirm: z.literal(true) }),
    async execute() {
      return withHint('Archiving the finished tasks', async () => {
        const archived = await store.archive();
        return { archived };
      });
    },
  }),
});

/** A task without its body, with the flag that says whether it is blocked. */
const slim = (task: Task, blocked: boolean) => ({
  id: task.id,
  title: task.title,
  status: task.status,
  type: task.type ?? 'task',
  priority: task.priority ?? 'normal',
  parent: task.parent ?? null,
  blocked,
});

/** The filters the list takes. */
interface Filters {
  status?: string[] | undefined;
  type?: string[] | undefined;
  priority?: string[] | undefined;
  tag?: string[] | undefined;
  parent?: string | undefined;
  search?: string | undefined;
}

/** Whether a task passes the filters of the list. */
const matches = (task: Task, args: Filters, open: Task[] | undefined): boolean => {
  if (open && !open.some((candidate) => candidate.id === task.id)) return false;
  if (!oneOf(args.status, task.status)) return false;
  if (!oneOf(args.type, task.type ?? 'task')) return false;
  if (!oneOf(args.priority, task.priority ?? 'normal')) return false;
  if (args.tag && !args.tag.some((tag) => (task.tags ?? []).includes(tag))) return false;
  if (args.parent !== undefined && task.parent !== args.parent) return false;
  return args.search === undefined || holdsText(task, args.search);
};

/** Whether a value is one of the allowed ones, or whether none are given. */
const oneOf = (allowed: string[] | undefined, value: string): boolean =>
  allowed === undefined || allowed.includes(value);

/** Whether the title or the body holds the text. */
const holdsText = (task: Task, search: string): boolean =>
  `${task.title}\n${task.body}`.toLowerCase().includes(search.toLowerCase());

/**
 * The result of a tool, or a sentence about why there is none.
 *
 * The caller is an agent: it can act on a sentence and it cannot act on a
 * stack trace, so the message says what failed and what to do next.
 */
const withHint = async (what: string, run: () => Promise<unknown>): Promise<unknown> => {
  try {
    return await run();
  } catch (error) {
    return `${what} failed: ${message(error)} ${hint(error)}`;
  }
};

/** The message of an error, whatever it is. */
const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The way out of a failure. */
const hint = (error: unknown): string => {
  if (error instanceof EtagMismatch) {
    return 'Read the task again with oa_task_show and repeat the update with the etag it gives.';
  }
  if (error instanceof InvalidStatusTransitionError) {
    return 'Leave the status as it is, or move it to a status the task may move to.';
  }
  if (error instanceof CircularDependencyError) {
    return 'Break the cycle: a task cannot depend on itself, directly or through another task.';
  }
  return 'Check the arguments and try again.';
};
