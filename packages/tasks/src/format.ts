import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { isPriority, isStatus, isTaskType, type Status, type Task } from './model.js';

/**
 * The file format: YAML front matter, a body, and the front-matter keys the
 * store understands.
 *
 * The shape is Beans' shape, down to the `# <id>` comment it writes as the
 * first front-matter line, because the point of the format is that a person
 * can keep using the tools they already have on the same files.
 */

/** The front-matter keys, in the order Beans writes them. */
export const FRONT_MATTER_KEYS = [
  'title',
  'status',
  'type',
  'priority',
  'tags',
  'created_at',
  'updated_at',
  'order',
  'parent',
  'blocking',
  'blocked_by',
] as const;

/**
 * The keys Beans leaves out when they are empty. `title` and `status` are
 * always written; the rest are omitted when they hold nothing.
 */
const OPTIONAL_KEYS = [
  'type',
  'priority',
  'tags',
  'created_at',
  'updated_at',
  'order',
  'parent',
  'blocking',
  'blocked_by',
] as const satisfies readonly (keyof Task)[];

/** The front matter and the body of a task file. */
const FILE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/**
 * Read a task file.
 *
 * The `# <id>` comment Beans writes as the first front-matter line is a YAML
 * comment, so the front matter parses without it. The id and the slug come
 * from the file name instead, which is where they are authoritative: two
 * files cannot claim the same id if only one of them is named after it.
 */
export function parseTask(raw: string, filename: string, relPath: string): Omit<Task, 'etag'> {
  const match = FILE.exec(raw);
  if (!match) throw new Error(`${relPath}: missing front matter`);
  const front = (parseYaml(match[1] ?? '') ?? {}) as Record<string, unknown>;
  const { id, slug } = parseFilename(filename);

  const task: Omit<Task, 'etag'> = {
    id,
    slug,
    path: relPath,
    title: text(front.title),
    status: status(front.status),
    body: (match[2] ?? '').replace(/^\n/, '').replace(/\n$/, ''),
  };

  const type = front.type;
  if (isTaskType(type)) task.type = type;
  const priority = front.priority;
  if (isPriority(priority)) task.priority = priority;
  const tags = front.tags;
  if (Array.isArray(tags)) task.tags = tags.map((tag) => text(tag));
  const created = front.created_at;
  if (created !== undefined) task.created_at = text(created);
  const updated = front.updated_at;
  if (updated !== undefined) task.updated_at = text(updated);
  const order = front.order;
  if (order !== undefined) task.order = text(order);
  const parent = front.parent;
  if (parent !== undefined) task.parent = text(parent);
  const blocking = front.blocking;
  if (Array.isArray(blocking)) task.blocking = blocking.map((id) => text(id));
  const blockedBy = front.blocked_by;
  if (Array.isArray(blockedBy)) task.blocked_by = blockedBy.map((id) => text(id));

  return task;
}

/**
 * Write a task file.
 *
 * The bytes are the ones Beans writes: the `# <id>` comment, the front
 * matter with a four-space list indent, and a body that starts and ends on
 * its own line. The line width is switched off, because a wrapped title
 * would make two stores disagree about a file neither of them changed.
 */
export function renderTask(task: Omit<Task, 'etag'>): string {
  const front: Record<string, unknown> = { title: task.title, status: task.status };
  for (const key of OPTIONAL_KEYS) {
    const value = task[key];
    if (value === undefined || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    front[key] = value;
  }
  const yaml = stringifyYaml(front, { indent: 4, indentSeq: true, lineWidth: 0 });
  const body = task.body ? `\n${task.body}\n` : '\n';
  return `---\n# ${task.id}\n${yaml}---\n${body}`;
}

/**
 * The id and the slug of a file name.
 *
 * Two forms are read: `id--slug.md`, which Beans writes today, and
 * `id.slug.md`, which it wrote before that. A name with neither is an id
 * with no slug.
 */
export function parseFilename(name: string): { id: string; slug: string } {
  const base = name.replace(/\.md$/, '');
  const dashed = base.indexOf('--');
  if (dashed > 0) return { id: base.slice(0, dashed), slug: base.slice(dashed + 2) };
  const dotted = base.indexOf('.');
  if (dotted > 0) return { id: base.slice(0, dotted), slug: base.slice(dotted + 1) };
  return { id: base, slug: '' };
}

/** The file name a task is stored under. */
export const buildFilename = (id: string, slug: string): string =>
  slug ? `${id}--${slug}.md` : `${id}.md`;

/** The file name of a task, with the path it is stored under. */
export const buildPath = (id: string, slug: string, directory = ''): string =>
  directory ? `${directory}/${buildFilename(id, slug)}` : buildFilename(id, slug);

/** A file name friendly form of a title. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50)
    .replace(/-$/, '');
}

/** A front-matter value read as a string. */
const text = (value: unknown): string =>
  value === undefined || value === null ? '' : String(value);

/**
 * The status of a task.
 *
 * A file that names a status the store does not know keeps that status:
 * the store does not rewrite a file it did not understand. The type says
 * `Status`, and an unknown status sorts last, so the file stays readable
 * without pretending it is valid.
 */
const status = (value: unknown): Status => (isStatus(value) ? value : (text(value) as Status));
