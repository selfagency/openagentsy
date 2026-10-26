import { statSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { etagOf } from '@openagentsy/core';
import {
  buildFilename,
  buildPath,
  parseFilename,
  parseTask,
  renderTask,
  slugify,
} from './format.js';
import { DEFAULT_LENGTH, DEFAULT_PREFIX, newId } from './ids.js';
import {
  isPriority,
  isStatus,
  isTaskType,
  type Priority,
  type Status,
  type Task,
  type TaskType,
  TERMINAL,
  validateTag,
} from './model.js';
import {
  CircularDependencyError,
  enforceContentRules,
  enforceStatusTransition,
  findCycle,
  InvalidStatusTransitionError,
} from './transitions.js';

/**
 * The task store: the files on disk, and the rules that write them.
 *
 * The store is the only thing that touches the filesystem. It reads a file
 * when the file changed and not before, because the prime block asks for
 * every task on every message, and it writes a file by writing a temporary
 * one and renaming it over the old, so a reader never sees half a task.
 */

/** What the store was asked to write down when it refused a change. */
export type AuditKind = 'oa.task.invalid_transition' | 'oa.task.cycle_detected';

/** How the store is set up. */
export interface TaskStoreOptions {
  /** The prefix every new id carries. */
  prefix?: string;
  /** The number of random characters in a new id. */
  idLength?: number;
  /** Where a refused change is written down. */
  onAudit?: (kind: AuditKind, detail: string) => void | Promise<void>;
}

/** The task a new one is created from. */
export interface CreateInput {
  title: string;
  status?: Status | undefined;
  type?: TaskType | undefined;
  priority?: Priority | undefined;
  tags?: string[] | undefined;
  parent?: string | undefined;
  blocked_by?: string[] | undefined;
  body?: string | undefined;
}

/** A change to a task. */
export interface TaskPatch {
  title?: string;
  status?: Status;
  type?: TaskType;
  priority?: Priority;
  addTags?: string[];
  removeTags?: string[];
  /** Null clears the parent. */
  parent?: string | null;
  addBlocking?: string[];
  addBlockedBy?: string[];
  removeBlocking?: string[];
  removeBlockedBy?: string[];
  bodyMod?: BodyMod;
}

/** A change to the body of a task. */
export interface BodyMod {
  /** Replacements, run in order. Each `old` must match exactly once. */
  replace?: { old: string; new: string }[];
  /** Text appended after the replacements. */
  append?: string;
}

/** The file did not change in the way the caller expected. */
export class EtagMismatch extends Error {
  constructor(readonly current: string) {
    super(`etag mismatch; current=${current}`);
    this.name = 'EtagMismatch';
  }
}

/** A file in the store, with what its name says about it. */
interface FileEntry {
  /** The path relative to the root of the store. */
  relPath: string;
  /** The id the name carries. */
  id: string;
  /** The slug the name carries. */
  slug: string;
  /** The path on disk. */
  absolute: string;
}

/** A parsed task and the state of the file it came from. */
interface Cached {
  task: Task;
  mtimeMs: number;
  size: number;
}

export class TaskStore {
  private readonly cache = new Map<string, Cached>();

  constructor(
    readonly root: string,
    private readonly options: TaskStoreOptions = {},
  ) {}

  /** The prefix every new id carries. */
  get prefix(): string {
    return this.options.prefix ?? DEFAULT_PREFIX;
  }

  /**
   * Every task in the store.
   *
   * The archived tasks are left out unless they are asked for: they are
   * history, and the working set is what a session reasons about.
   */
  async all(includeArchive = false): Promise<Task[]> {
    const entries = await this.collect(includeArchive);
    const tasks = await Promise.all(entries.map((entry) => this.read(entry)));
    return tasks.filter((task): task is Task => task !== undefined);
  }

  /**
   * One task, by its id.
   *
   * The name of a file carries the id, so the file is found without being
   * read: only the file that matches is opened.
   */
  async get(id: string): Promise<Task | undefined> {
    const entries = await this.collect(true);
    const entry = entries.find((candidate) => candidate.id === id);
    if (!entry) return undefined;
    return this.read(entry);
  }

  /**
   * A new task.
   *
   * The id is drawn, the slug comes from the title, and the file is written
   * before the task is returned, so what the caller holds is what is on
   * disk.
   */
  async create(input: CreateInput): Promise<Task> {
    const now = timestamp();
    const id = newId(this.prefix, this.options.idLength ?? DEFAULT_LENGTH);
    const slug = slugify(input.title);
    const task: Omit<Task, 'etag'> = {
      id,
      slug,
      path: buildFilename(id, slug),
      title: input.title,
      status: input.status ?? 'todo',
      type: input.type ?? 'task',
      body: input.body ?? '',
      created_at: now,
      updated_at: now,
    };
    if (input.priority !== undefined) task.priority = input.priority;
    if (input.tags !== undefined) task.tags = input.tags;
    if (input.parent !== undefined) task.parent = input.parent;
    if (input.blocked_by !== undefined) task.blocked_by = input.blocked_by;

    enforceContentRules(task);

    await this.assertNoCycle({ ...task, etag: '' });
    await this.write(task);
    const written = await this.get(id);
    if (!written) throw new Error(`task ${id} is missing right after it was written`);
    return written;
  }

  /**
   * A changed task.
   *
   * The etag, when the caller gives one, is checked against the file as it
   * is now: a caller that read a task and then found it changed elsewhere
   * is told, instead of overwriting the other writer's work.
   */
  async update(id: string, patch: TaskPatch, ifMatch?: string): Promise<Task> {
    const current = await this.get(id);
    if (!current) throw new Error(`no task ${id}`);
    if (ifMatch !== undefined && ifMatch !== current.etag) {
      throw new EtagMismatch(current.etag);
    }

    const next = applyPatch(current, patch);
    try {
      enforceStatusTransition(current, next);
    } catch (error) {
      if (error instanceof InvalidStatusTransitionError) {
        await this.audit('oa.task.invalid_transition', error.message);
      }
      throw error;
    }
    enforceContentRules(next);
    try {
      await this.assertNoCycle(next);
    } catch (error) {
      if (error instanceof CircularDependencyError) {
        await this.audit('oa.task.cycle_detected', error.message);
      }
      throw error;
    }

    next.updated_at = timestamp();
    await this.write(next);
    const written = await this.get(id);
    if (!written) throw new Error(`task ${id} is missing right after it was written`);
    return written;
  }

  /**
   * The finished tasks, moved out of the working set.
   *
   * The files are moved, not copied: a task is in one place or the other,
   * and the archive is committed with the code.
   */
  async archive(): Promise<string[]> {
    const tasks = await this.all();
    const moved: string[] = [];
    for (const task of tasks) {
      if (!TERMINAL.has(task.status)) continue;
      const from = join(this.root, task.path);
      const to = join(this.root, buildPath(task.id, task.slug, 'archive'));
      await mkdir(dirname(to), { recursive: true });
      await rename(from, to);
      this.cache.delete(from);
      moved.push(task.id);
    }
    return moved;
  }

  /** The files in the store, with what their names say about them. */
  private async collect(includeArchive: boolean): Promise<FileEntry[]> {
    const entries = await this.list('');
    if (includeArchive) entries.push(...(await this.list('archive')));
    return entries;
  }

  /** The task files of one directory. */
  private async list(directory: string): Promise<FileEntry[]> {
    const absolute = directory ? join(this.root, directory) : this.root;
    let names: string[];
    try {
      names = await readdir(absolute);
    } catch {
      return [];
    }
    const entries: FileEntry[] = [];
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const { id, slug } = parseFilename(name);
      entries.push({
        relPath: directory ? `${directory}/${name}` : name,
        id,
        slug,
        absolute: join(absolute, name),
      });
    }
    return entries;
  }

  /**
   * The task in a file.
   *
   * The file is opened only when it changed: the prime block asks for every
   * task on every message, and a stat is a fraction of the cost of a parse.
   */
  private async read(entry: FileEntry): Promise<Task | undefined> {
    // The stat is synchronous on purpose. A sweep of five hundred files
    // costs about a millisecond of system time either way, but the
    // asynchronous form pays the thread pool a promise, a request and a
    // completion for every one of them, and that is two or three times the
    // CPU of the same work. The block is short, it is bounded by the
    // number of files, and it is the price of the prime staying cheap.
    const info = statSync(entry.absolute, { throwIfNoEntry: false });
    if (!info) return undefined;
    const cached = this.cache.get(entry.absolute);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      return cached.task;
    }
    const raw = await readFile(entry.absolute, 'utf8');
    const name = entry.relPath.split('/').pop() ?? entry.relPath;
    const task: Task = {
      ...parseTask(raw, name, entry.relPath),
      etag: etagOf(raw),
    };
    this.cache.set(entry.absolute, { task, mtimeMs: info.mtimeMs, size: info.size });
    return task;
  }

  /** The file, written so that a reader never sees half of it. */
  private async write(task: Omit<Task, 'etag'>): Promise<void> {
    const file = join(this.root, task.path);
    const temporary = `${file}.${process.pid}.tmp`;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(temporary, renderTask(task), 'utf8');
    await rename(temporary, file);
    this.cache.delete(file);
  }

  /** The refusal of a change, written down where the board can see it. */
  private async audit(kind: AuditKind, detail: string): Promise<void> {
    await this.options.onAudit?.(kind, detail);
  }

  /** The tasks of the store, with one of them replaced. */
  private async assertNoCycle(next: Task): Promise<void> {
    const tasks = await this.all();
    const merged = tasks.filter((task) => task.id !== next.id);
    merged.push(next);
    const cycle = findCycle(merged);
    if (cycle) throw new CircularDependencyError(cycle);
  }
}

/**
 * A changed task, without a change.
 *
 * The patch is applied to a copy, so a patch that turns out to be invalid
 * leaves the task as it was.
 */
export function applyPatch(current: Task, patch: TaskPatch): Task {
  const next: Task = { ...current };
  applyMetadata(next, patch);
  applyTags(next, patch);
  applyRelations(next, patch);
  if (patch.bodyMod !== undefined) next.body = applyBodyMod(current.body, patch.bodyMod);
  return next;
}

/** The plain fields of a task: the title, the status, the type, the priority. */
function applyMetadata(next: Task, patch: TaskPatch): void {
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.status !== undefined) {
    if (!isStatus(patch.status)) throw new Error(`invalid status "${patch.status}"`);
    next.status = patch.status;
  }
  if (patch.type !== undefined) {
    if (!isTaskType(patch.type)) throw new Error(`invalid type "${patch.type}"`);
    next.type = patch.type;
  }
  if (patch.priority !== undefined) {
    if (!isPriority(patch.priority)) throw new Error(`invalid priority "${patch.priority}"`);
    next.priority = patch.priority;
  }
}

/** The tags of a task. */
function applyTags(next: Task, patch: TaskPatch): void {
  if (patch.addTags === undefined && patch.removeTags === undefined) return;
  const tags = new Set(next.tags ?? []);
  for (const tag of patch.addTags ?? []) {
    if (!validateTag(tag)) throw new Error(`Invalid tag "${tag}"`);
    tags.add(tag);
  }
  for (const tag of patch.removeTags ?? []) tags.delete(tag);
  next.tags = [...tags];
}

/** The relations of a task: the parent, the blockers, the blocked. */
function applyRelations(next: Task, patch: TaskPatch): void {
  if (patch.parent !== undefined) {
    if (patch.parent === null) delete next.parent;
    else next.parent = patch.parent;
  }
  if (patch.addBlocking !== undefined || patch.removeBlocking !== undefined) {
    next.blocking = mergeIds(next.blocking, patch.addBlocking, patch.removeBlocking);
  }
  if (patch.addBlockedBy !== undefined || patch.removeBlockedBy !== undefined) {
    next.blocked_by = mergeIds(next.blocked_by, patch.addBlockedBy, patch.removeBlockedBy);
  }
}

/**
 * A body with a change applied to it.
 *
 * A replacement has to match exactly once: a text that appears twice is
 * ambiguous, and an agent that meant one of them would get the other.
 * Anything that fails leaves the body as it was, because the caller writes
 * the result only when this returns.
 */
export function applyBodyMod(body: string, mod: BodyMod): string {
  let result = body;
  for (const replacement of mod.replace ?? []) {
    if (replacement.old === '') {
      throw new Error('the text of a replacement cannot be empty');
    }
    const count = countOccurrences(result, replacement.old);
    if (count === 0) {
      throw new Error(`the text to replace is not in the body: ${truncate(replacement.old)}`);
    }
    if (count > 1) {
      throw new Error(`the text to replace appears ${count} times in the body and must be unique`);
    }
    result = result.replace(replacement.old, () => replacement.new);
  }
  if (mod.append !== undefined && mod.append !== '') {
    result = result === '' ? mod.append : `${result.replace(/\n+$/, '')}\n\n${mod.append}`;
  }
  return result;
}

/** How many times a text appears in a body. */
function countOccurrences(body: string, text: string): number {
  let count = 0;
  let at = body.indexOf(text);
  while (at !== -1) {
    count++;
    at = body.indexOf(text, at + text.length);
  }
  return count;
}

/** A list of ids, with some added and some removed. */
function mergeIds(
  current: string[] | undefined,
  add: string[] | undefined,
  remove: string[] | undefined,
): string[] {
  const ids = new Set(current ?? []);
  for (const id of add ?? []) ids.add(id);
  for (const id of remove ?? []) ids.delete(id);
  return [...ids];
}

/** A timestamp without the milliseconds, the way the files carry it. */
const timestamp = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

/** A short form of a text, for a message about it. */
const truncate = (text: string): string => (text.length > 40 ? `${text.slice(0, 40)}…` : text);
