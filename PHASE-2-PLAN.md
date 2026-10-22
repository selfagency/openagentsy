# OpenAgentsy Phase 2: Implementation Plan

**Bottom line.** Phase 2 ships six packages and one change to repo tooling:

- **Repo tooling (2.0).** Biome handles linting and formatting. Husky and lint-staged run it on every commit and block the commit when it fails. `tsc --noEmit` handles typechecking.
- **`@openagentsy/tasks`.** A built-in task tracker that reads and writes the Beans `.beans/` Markdown format directly. It needs neither `beans-mcp` nor the `beans` CLI.
- **`@openagentsy/footprint`.** Energy, water, carbon and warming estimates using the EcoLogits method. Every number carries a range.
- **`@openagentsy/ledger`.** A local SQLite ledger of tokens and cost per message. It also records waste signals and outcomes: tokens per completed task and per commit.
- **`@openagentsy/hooks`.** Deterministic guardrails built on agentsy's `HookRegistry`, plus secret redaction and the patch review queue.
- **`@openagentsy/offload`.** Routes small housekeeping jobs (titles, summaries, JSON repair, quick replies) to a local model.
- **`@openagentsy/sidebar`.** The OpenCode V2 TUI sidebar blocks, with a toast and slash-command fallback for V1.

Code below is TypeScript in the style of the Phase 1 codebase. Where an OpenCode API detail is inferred rather than read from source, it's marked **VERIFY**.

---

## 0. Licensing

Phase 2 reuses code from agentsy (GPL-3.0-or-later; the MIT mention in its README is stale), so **the OpenAgentsy packages that import it must be GPL-3.0-or-later.** The simplest option is to license the whole monorepo GPL-3.0-or-later. The other sources are compatible:

| Source | License | How we use it |
| --- | --- | --- |
| agentsy (`@agentsy/runtime` hooks, `@agentsy/core/structured`) | GPL-3.0-or-later | Imported as a dependency. |
| hmans/beans | Apache-2.0 | File format re-implemented. Fractional-index algorithm ported, with an attribution header and NOTICE entry (Apache-2.0 code may go into GPL-3 works). |
| junhoyeo/tokscale | MIT | Ideas only: OpenCode DB discovery, pricing fallback chain, dedup rules. |
| xiufengsun/TokenTracker | MIT | Ideas only: outcomes sidecar, git attribution, privacy rules. |
| EcoLogits methodology | CC BY-SA 4.0 (docs) | Formulas re-implemented, with credit in the UI and README. **VERIFY** the license of `ecologits/data/models.json` before bundling it. Until then, fetch it at runtime and cache it. |

```jsonc
// package.json (root)
{ "license": "GPL-3.0-or-later" }
```

---

## 1. 2.0: Biome, Husky and lint-staged

> **Resolved.** Implemented on 2026-10-22. Biome 2.6.2, Husky 9.1.7, lint-staged 17.6.0.
> `biome.jsonc`, `.husky/pre-commit`, `.github/workflows/check.yml` and
> `.github/workflows/eval.yml` are in the repo. The whole codebase was formatted
> once, and every non-null assertion was replaced with a real check, because
> `noNonNullAssertion` is on in the recommended set. Markdown is excluded from
> Biome: its table formatting is experimental and the plan's own lint-staged
> pattern never covered `.md`. The safety suite runs on a pull request once the
> pull request has left draft.

Add this **now**, while the Phase 0/1 build is still running, so the code being written today is formatted from the start.

```bash
pnpm add -D -E @biomejs/biome
pnpm add -D husky lint-staged
pnpm exec husky init
```

`biome.jsonc`:

```jsonc
{
  "$schema": "./node_modules/@biomejs/biome/configuration_schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": { "includes": ["**", "!**/dist", "!**/.beans", "!**/.openagentsy"] },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "javascript": { "formatter": { "quoteStyle": "single", "semicolons": "always" } },
  "assist": { "actions": { "source": { "organizeImports": "on" } } },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "suspicious": { "noExplicitAny": "error", "noConsole": "error" },
      "correctness": { "noUnusedVariables": "error", "noUnusedImports": "error" },
      "style": { "useConst": "error" }
    }
  },
  "overrides": [
    { "includes": ["evals/**", "**/*.test.ts"], "linter": { "rules": { "suspicious": { "noExplicitAny": "off" } } } },
    { "includes": ["scripts/**"], "linter": { "rules": { "suspicious": { "noConsole": "off" } } } }
  ]
}
```

**VERIFY** the key names against the Biome major version you pin. Biome 2 renamed `ignore`/`include` to `files.includes` with `!` negation, and moved import sorting under `assist`. `biome migrate --write` fixes up an older config.

`package.json`:

```jsonc
{
  "scripts": {
    "prepare": "husky",
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "typecheck": "tsc -b --noEmit",
    "ci:check": "biome ci . && pnpm typecheck"
  },
  "lint-staged": {
    "*.{js,mjs,cjs,ts,mts,cts,tsx,json,jsonc}": [
      "biome check --write --no-errors-on-unmatched --files-ignore-unknown=true"
    ]
  }
}
```

`.husky/pre-commit`:

```sh
pnpm exec lint-staged
pnpm typecheck
```

`.github/workflows/check.yml` runs `pnpm ci:check` on every PR, so `--no-verify` can't get anything past the gate.

**Blocking behaviour.**

- Biome exits non-zero on lint errors. lint-staged then aborts, and Husky stops the commit.
- Fixable formatting is written back and re-staged automatically.
- `tsc` runs on the whole project because types need the full program. If it gets slow, move it to `.husky/pre-push`.

**Agents go through the same hook.** §7.3 adds a hook rule that denies `--no-verify`, `-n` on `git commit`, and `HUSKY=0` in agent shell calls. When the pre-commit hook fails, its output comes back to the agent as a tool error so the agent fixes the code.

---

## 2. Package layout

```
packages/
  tasks/        # .beans-compatible task store + oa_task_* tools + prime injection
  footprint/    # EcoLogits-method estimator (pure, no I/O)
  ledger/       # SQLite usage ledger, pricing, waste signals, outcomes
  hooks/        # agentsy HookRegistry adapter, guardrail rules, redaction, patch queue
  offload/      # local-model router (Ollama / LM Studio) for micro-tasks
  sidebar/      # V2 TUI plugin (dist/tui.js) + V1 server fallback (dist/v1.js)
  adapters/     # from Phase 1: V1/V2 defineTool, event bridge
```

Dependency direction runs `footprint` → `ledger` → `sidebar`, and `tasks` → `sidebar`. `hooks` depends only on `@agentsy/runtime`. `footprint` and the parts of `tasks` that do no I/O stay pure, so they can be tested without OpenCode.

---

## 3. `@openagentsy/tasks`: Beans-compatible tasks without Beans

### 3.1 What to copy from Beans

Beans' creator has turned it into an orchestrator: a web UI that spawns Claude Code processes per bean, manages git worktrees, generates quick replies and has a GraphQL server [^beans]. We keep the **file format** and the **good workflow ideas**, and drop the runtime.

| Beans idea | OpenAgentsy decision |
| --- | --- |
| Tasks are Markdown files with YAML front matter in `.beans/`, committed with the code | **Keep, byte-compatible.** People can still use `beans tui` if they want, but nothing requires it. |
| Fixed statuses `in-progress, todo, draft, completed, scrapped`; types `milestone, epic, bug, feature, task`; priorities `critical, high, normal, low, deferred` | **Keep** the same lists, in the same sort order. |
| `parent`, `blocking`, `blocked_by`; blocked state and terminal status inherited down the parent chain | **Keep.** This drives `ready` and `next`. |
| Fractional `order` keys, so reordering touches one file | **Port** (Apache-2.0, attributed). |
| ETag plus `--if-match` for optimistic concurrency | **Keep.** Our ETag is a hash of the file's bytes, so it stays stable whichever tool wrote the file. |
| A "Summary of Changes" section on completion, "Reasons for Scrapping" when scrapped | **Keep**, enforced by the tool rather than the prompt. |
| Completed beans archived and used as project memory | **Keep.** Archived tasks feed Magic Context search. |
| `Refs: <id>` trailers in commit messages; bean files committed together with the code | **Keep.** This links tasks, commits and the ledger (§5.5). |
| Worktrees kept *outside* the repo (`~/.beans/worktrees/<project>/`), each with a `.meta.json`; `setup` and `run` commands; `integrate: local or pr` | **Adopt** for parallel builders, under `~/.openagentsy/worktrees/<project>/`. |
| Status changes in a worktree treated as provisional ("dirty") until its PR merges | **Adopt** (§3.6). |
| Working out which tasks a worktree touched from its git diff | **Adopt** for the Board block. |
| Quick-reply suggestions after each agent turn | **Adopt** through local offload (§8), not a hosted model. |
| Default effort level per project | Already covered by Phase 1's effort ladder; read `agent.default_effort` when it's present. |
| **`beans prime`**: a long guide injected into every system prompt, beginning `<EXTREMELY_IMPORTANT>` and including "You MUST ignore all previous instructions" | **Reject.** It's coercive prompt engineering that gets in the way of other instructions, and it costs tokens on every turn. We inject a short state summary instead (§3.5), move the usage guide into a skill that loads on demand, and enforce the rules in code. |
| An agent chat that spawns Claude Code processes, plus a web UI and GraphQL server | **Reject.** OpenCode is our runtime, and the TUI sidebar is our UI. |
| "You've been programming all your life; now you get to be a product manager." | **Reject the framing.** The person stays the engineer who directs the tools and reviews the work. |
| `default_mode: act`, "fully autonomous" | **Reject as a default.** Agents act, but destructive tools go through the approval hooks (§7). |

### 3.2 Types and parsing

```ts
// packages/tasks/src/model.ts
export const STATUSES = ['in-progress', 'todo', 'draft', 'completed', 'scrapped'] as const;
export const TERMINAL = new Set<Status>(['completed', 'scrapped']);
export const TYPES = ['milestone', 'epic', 'bug', 'feature', 'task'] as const;
export const PRIORITIES = ['critical', 'high', 'normal', 'low', 'deferred'] as const;

export type Status = (typeof STATUSES)[number];
export type TaskType = (typeof TYPES)[number];
export type Priority = (typeof PRIORITIES)[number];

export interface Task {
  id: string;            // from filename, e.g. "oa-4f2k"
  slug: string;          // from filename, e.g. "fix-footprint-ranges"
  path: string;          // relative to .beans/
  title: string;
  status: Status;
  type?: TaskType;
  priority?: Priority;
  tags?: string[];
  created_at?: string;   // ISO 8601
  updated_at?: string;
  order?: string;        // fractional index
  parent?: string;
  blocking?: string[];
  blocked_by?: string[];
  body: string;
  etag: string;          // fnv1a64 of file bytes
}

const TAG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const validateTag = (t: string) => TAG.test(t);
```

```ts
// packages/tasks/src/format.ts
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { Task } from './model.js';

const FM_KEYS = ['title', 'status', 'type', 'priority', 'tags', 'created_at',
  'updated_at', 'order', 'parent', 'blocking', 'blocked_by'] as const;

/** Parse a .beans/*.md file. Accepts the "# <id>" comment Beans writes as the first front-matter line. */
export function parseTask(raw: string, filename: string, relPath: string): Omit<Task, 'etag'> {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!m) throw new Error(`${relPath}: missing front matter`);
  const fm = (parseYaml(m[1] ?? '') ?? {}) as Record<string, unknown>;
  const { id, slug } = parseFilename(filename);
  return {
    id, slug, path: relPath,
    ...(Object.fromEntries(FM_KEYS.filter((k) => fm[k] !== undefined).map((k) => [k, fm[k]])) as Partial<Task>),
    title: String(fm.title ?? ''),
    status: (fm.status as Task['status']) ?? 'todo',
    body: (m[2] ?? '').replace(/^\n/, '').replace(/\n$/, ''),
  };
}

/** Render in the same shape Beans writes: "# id" comment, yaml.v3-style 4-space list indent. */
export function renderTask(t: Omit<Task, 'etag'>): string {
  const fm: Record<string, unknown> = {};
  for (const k of FM_KEYS) {
    const v = t[k];
    if (v !== undefined && !(Array.isArray(v) && v.length === 0)) fm[k] = v;
  }
  const yaml = stringifyYaml(fm, { indent: 4, indentSeq: true, lineWidth: 0 });
  const body = t.body ? `\n${t.body}\n` : '\n';
  return `---\n# ${t.id}\n${yaml}---\n${body}`;
}

export function parseFilename(name: string): { id: string; slug: string } {
  const base = name.replace(/\.md$/, '');
  const dd = base.indexOf('--');
  if (dd > 0) return { id: base.slice(0, dd), slug: base.slice(dd + 2) };
  const dot = base.indexOf('.');
  if (dot > 0) return { id: base.slice(0, dot), slug: base.slice(dot + 1) };
  return { id: base, slug: '' };
}

export const buildFilename = (id: string, slug: string) => (slug ? `${id}--${slug}.md` : `${id}.md`);

export function slugify(title: string): string {
  return title.toLowerCase().replace(/[\s_]+/g, '-').replace(/[^\p{L}\p{N}-]/gu, '')
    .replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 50).replace(/-$/, '');
}
```

**Round-trip test.** Parsing, rendering and parsing again must give the same `Task` for every file in a copy of `hmans/beans/.beans/`. The test also diffs our rendered bytes against the original files and logs any whitespace differences, so we know before release whether `beans` and OpenAgentsy writing the same file would produce noisy diffs.

### 3.3 IDs, ETags, ordering

```ts
// packages/tasks/src/ids.ts
import { customAlphabet } from 'nanoid';
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
// Same intent as Beans' blockedIDWords list; keep it in a data file so it can be reviewed and extended.
import BLOCKED from './blocked-id-words.json' with { type: 'json' };

export function newId(prefix: string, length = 4): string {
  const gen = customAlphabet(ALPHABET, length);
  for (;;) {
    const id = gen();
    if (!BLOCKED.some((w: string) => id.includes(w))) return prefix + id;
  }
}

// FNV-1a 64-bit over the raw file bytes → 16 hex chars.
export function etag(bytes: Uint8Array): string {
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) { h ^= BigInt(b); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; }
  return h.toString(16).padStart(16, '0');
}
```

```ts
// packages/tasks/src/fractional.ts
// Ported from hmans/beans pkg/bean/fractional.go (Apache-2.0). See NOTICE.
const D = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export function orderBetween(a = '', b = ''): string { /* direct port of OrderBetween/midpoint/increment/decrement */ }
```

Test `fractional.ts` against Beans' `fractional_test.go` cases, translated into a table-driven Vitest file.

### 3.4 Store

```ts
// packages/tasks/src/store.ts
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export class EtagMismatch extends Error {
  constructor(public current: string) { super(`etag mismatch; current=${current}`); }
}

export class TaskStore {
  constructor(private root: string, private prefix: string) {}   // root = <repo>/.beans

  async all(includeArchive = false): Promise<Task[]> { /* readdir root (+ archive/), parseTask, attach etag */ }
  async get(id: string): Promise<Task | undefined> { /* index by id → path */ }

  async create(input: Pick<Task, 'title'> & Partial<Task>): Promise<Task> {
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const t = { status: 'todo' as const, type: 'task' as const, ...input,
      id: newId(this.prefix), slug: slugify(input.title), created_at: now, updated_at: now, body: input.body ?? '' };
    t.path = buildFilename(t.id, t.slug);
    await this.write(t);
    return (await this.get(t.id))!;
  }

  /** Atomic write: temp file + rename. If ifMatch is given, compare with current etag first. */
  async update(id: string, patch: TaskPatch, ifMatch?: string): Promise<Task> {
    const cur = await this.get(id);
    if (!cur) throw new Error(`no task ${id}`);
    if (ifMatch && ifMatch !== cur.etag) throw new EtagMismatch(cur.etag);
    const next = applyPatch(cur, patch);        // see bodyMod below; throws on invalid status/type/priority/tag
    enforceTransitions(cur, next);              // §3.7
    next.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    await this.write(next);
    return (await this.get(id))!;
  }

  private async write(t: Omit<Task, 'etag'>) {
    const file = join(this.root, t.path);
    const tmp = `${file}.${process.pid}.tmp`;
    await mkdir(this.root, { recursive: true });
    await writeFile(tmp, renderTask(t), 'utf8');
    await rename(tmp, file);
  }
}

export interface TaskPatch {
  title?: string; status?: Status; type?: TaskType; priority?: Priority;
  addTags?: string[]; removeTags?: string[];
  parent?: string | null; addBlocking?: string[]; addBlockedBy?: string[];
  removeBlocking?: string[]; removeBlockedBy?: string[];
  bodyMod?: { replace?: { old: string; new: string }[]; append?: string };
}
```

`bodyMod` follows Beans' rules:

- Replacements run in order, and each `old` must match **exactly once**.
- `append` runs after all replacements and adds a blank-line separator.
- If any step fails, nothing is written.

### 3.5 Ready, next, and the short prime

```ts
// packages/tasks/src/query.ts
const STATUS_RANK = new Map(STATUSES.map((s, i) => [s, i]));
const PRIO_RANK = new Map(PRIORITIES.map((p, i) => [p, i]));

export function index(tasks: Task[]) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const blockers = new Map<string, Set<string>>();          // id → ids blocking it
  for (const t of tasks) {
    for (const b of t.blocked_by ?? []) (blockers.get(t.id) ?? blockers.set(t.id, new Set()).get(t.id)!).add(b);
    for (const v of t.blocking ?? []) (blockers.get(v) ?? blockers.set(v, new Set()).get(v)!).add(t.id);
  }
  const ancestors = (t: Task): Task[] => {
    const out: Task[] = []; const seen = new Set<string>();
    for (let p = t.parent && byId.get(t.parent); p && !seen.has(p.id); p = p.parent ? byId.get(p.parent) : undefined) {
      seen.add(p.id); out.push(p);
    }
    return out;
  };
  const directlyBlocked = (t: Task) =>
    [...(blockers.get(t.id) ?? [])].some((id) => { const b = byId.get(id); return b && !TERMINAL.has(b.status); });
  const isBlocked = (t: Task) => directlyBlocked(t) || ancestors(t).some(directlyBlocked);
  const effectiveTerminal = (t: Task) => TERMINAL.has(t.status) || ancestors(t).some((a) => TERMINAL.has(a.status));
  return { byId, isBlocked, effectiveTerminal, ancestors };
}

export const sortTasks = (a: Task, b: Task) =>
  (STATUS_RANK.get(a.status)! - STATUS_RANK.get(b.status)!) ||
  (PRIO_RANK.get(a.priority ?? 'normal')! - PRIO_RANK.get(b.priority ?? 'normal')!) ||
  (a.order ?? '').localeCompare(b.order ?? '') ||
  (a.created_at ?? '').localeCompare(b.created_at ?? '');

export function ready(tasks: Task[]): Task[] {
  const ix = index(tasks);
  return tasks.filter((t) => t.status === 'todo' && t.type !== 'epic' && t.type !== 'milestone'
    && !ix.isBlocked(t) && !ix.effectiveTerminal(t)).sort(sortTasks);
}
export const next = (tasks: Task[]) => ready(tasks)[0];
```

**Prime injection.** This is a compact state block, about 150 tokens, not a 1,500-token manual.

```ts
// packages/tasks/src/prime.ts
export function primeBlock(tasks: Task[]): string {
  const live = tasks.filter((t) => !TERMINAL.has(t.status));
  const inProg = live.filter((t) => t.status === 'in-progress').slice(0, 3);
  const top = ready(tasks).slice(0, 5);
  const fmt = (t: Task) => `- ${t.id} [${t.type ?? 'task'}/${t.priority ?? 'normal'}] ${t.title}`;
  return [
    '## Project tasks (.beans)',
    `${live.length} open; ${inProg.length} in progress; ${ready(tasks).length} ready.`,
    inProg.length ? `In progress:\n${inProg.map(fmt).join('\n')}` : '',
    top.length ? `Ready next:\n${top.map(fmt).join('\n')}` : '',
    'Use the oa_task_* tools to read or change tasks. Load the "tasks" skill for conventions.',
  ].filter(Boolean).join('\n');
}
```

V1 wiring uses the same hooks the Beans OpenCode plugin uses [^beansplugin]:

```ts
// packages/tasks/src/v1.ts
import type { Plugin } from '@opencode-ai/plugin';

export const OpenAgentsyTasks: Plugin = async ({ directory }) => {
  const store = await openStore(directory);           // finds .beans.yml upward; prefix from config
  const prime = async () => primeBlock(await store.all());
  return {
    'experimental.chat.system.transform': async (_input, output) => { output.system.push(await prime()); },
    'experimental.session.compacting': async (_input, output) => { output.context.push(await prime()); },
    tool: taskTools(store),                           // §3.6; VERIFY tool registration shape for your plugin SDK version
  };
};
```

On V2, the same `primeBlock` goes through the Phase 1 adapter's system-prompt hook.

### 3.6 Tools

These are registered through the Phase 1 `defineTool` adapter, so V1 and V2 share one definition:

```ts
// packages/tasks/src/tools.ts
import { z } from 'zod';
import { defineTool } from '@openagentsy/adapters';

export const taskTools = (store: TaskStore) => ({
  oa_task_list: defineTool({
    description: 'List tasks. Returns id, title, status, type, priority, parent, blocked flag. No bodies.',
    args: z.object({
      status: z.array(z.enum(STATUSES)).optional(),
      type: z.array(z.enum(TYPES)).optional(),
      priority: z.array(z.enum(PRIORITIES)).optional(),
      tag: z.array(z.string()).optional(),
      parent: z.string().optional(),
      ready: z.boolean().optional(),
      search: z.string().optional(),            // title + body substring, case-insensitive
      limit: z.number().int().max(200).default(50),
    }),
    async execute(a) { /* filter → sortTasks → slim rows */ },
  }),
  oa_task_show: defineTool({
    description: 'Full task(s) including body, etag, children and blockers.',
    args: z.object({ ids: z.array(z.string()).min(1).max(10) }),
    async execute({ ids }) { /* ... */ },
  }),
  oa_task_create: defineTool({
    description: 'Create a task. Always give a type. Prefer blocked_by for dependent work.',
    args: z.object({ title: z.string().min(3), type: z.enum(TYPES), status: z.enum(STATUSES).default('todo'),
      priority: z.enum(PRIORITIES).optional(), body: z.string().optional(), parent: z.string().optional(),
      blocked_by: z.array(z.string()).optional(), tags: z.array(z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)).optional() }),
    async execute(a) { return store.create(a); },
  }),
  oa_task_update: defineTool({
    description: 'Update metadata and/or body. Pass if_match (etag) to avoid clobbering concurrent edits.',
    args: z.object({ id: z.string(), if_match: z.string().optional(), patch: TaskPatchSchema }),
    async execute({ id, if_match, patch }) { return store.update(id, patch, if_match); },
  }),
  oa_task_next: defineTool({
    description: 'The single highest-priority ready task, with body.',
    args: z.object({}),
    async execute() { return next(await store.all()) ?? { none: true, hint: 'Nothing ready; check blocked tasks.' }; },
  }),
  oa_task_archive: defineTool({
    description: 'Move completed/scrapped tasks to .beans/archive/. Only when the user asks.',
    args: z.object({ confirm: z.literal(true) }),
    async execute() { /* rename terminal tasks into archive/ */ },
  }),
});
```

**Token discipline.**

- `list` never returns bodies; `show` caps how many tasks it returns.
- Errors carry a short recovery hint, as in the board API.

### 3.7 Rules the code enforces, so prompts don't have to

```ts
function enforceTransitions(cur: Task, next: Task) {
  if (next.status === 'completed') {
    if (/- \[ \]/.test(next.body)) throw new Error('Unchecked items remain; check them off or move them to a follow-up task.');
    if (!/^## Summary of Changes/m.test(next.body)) throw new Error('Add a "## Summary of Changes" section before completing.');
  }
  if (next.status === 'scrapped' && !/^## Reasons for Scrapping/m.test(next.body))
    throw new Error('Add a "## Reasons for Scrapping" section before scrapping.');
  if (next.type === 'epic' && next.status === 'in-progress')
    throw new Error('Epics are containers; start one of their child tasks instead.');
  for (const t of next.tags ?? []) if (!validateTag(t)) throw new Error(`Invalid tag "${t}"`);
}
```

### 3.8 Worktrees for parallel builders (adapted from Beans)

```ts
// packages/tasks/src/worktree.ts
export interface WorktreeMeta { id: string; taskIds: string[]; branch: string; createdAt: string; lastActive: string; port?: number }

// Location outside the repo avoids nested-repo confusion and search/tool interference.
export const worktreeRoot = (project: string) => join(homedir(), '.openagentsy', 'worktrees', project);

export async function createWorktree(repo: string, cfg: OaWorktreeConfig, taskId: string): Promise<WorktreeMeta> {
  // 1. git fetch (timeout cfg.fetchTimeoutSec, default 10, 0 = skip)
  // 2. git worktree add -b oa/<taskId> <root>/<taskId> <cfg.baseRef ?? 'main'>
  // 3. run cfg.setup in the worktree (through the hooks' shell policy)
  // 4. write <root>/<taskId>.meta.json
}

/** Which tasks a worktree touched, from its diff against base. This is the source of truth for the Board block. */
export async function detectTaskIds(worktree: string, baseRef: string): Promise<string[]> {
  // git diff --name-only <baseRef>...HEAD -- .beans/  → parseFilename(...).id
}
```

**Provisional status.** A builder working in a worktree edits the `.beans/` files *inside that worktree*, so its task changes travel with the PR. The Lead's view overlays those edits as provisional and shows them dimmed in the Board block until the branch merges into the base ref.

`integrate: local | pr` follows Beans:
- `local` squash-merges after the reviewer approves.
- `pr` pushes and opens a PR.

Either way, the merge needs a person's approval through the approval hook.

---

## 4. `@openagentsy/footprint`: the estimator

This package is pure TypeScript with no I/O. Every quantity is an interval, `[lo, hi]`.

### 4.1 Types

```ts
// packages/footprint/src/types.ts
export type Range = readonly [lo: number, hi: number];
export const r = (lo: number, hi = lo): Range => [Math.min(lo, hi), Math.max(lo, hi)];
export const add = (a: Range, b: Range): Range => [a[0] + b[0], a[1] + b[1]];
export const mul = (a: Range, b: Range): Range => {
  const p = [a[0] * b[0], a[0] * b[1], a[1] * b[0], a[1] * b[1]];
  return [Math.min(...p), Math.max(...p)];
};
export const scale = (a: Range, k: number): Range => r(a[0] * k, a[1] * k);

export interface ModelArch {
  totalParamsB: Range;          // billions
  activeParamsB: Range;         // = total for dense; EcoLogits uses 10–30% activation for MoE when unknown
  source: 'ecologits' | 'model-card' | 'user' | 'unknown';
}

export interface SiteProfile {
  pue: Range;
  wueOnSite: Range;             // L/kWh, data-centre cooling
  wueOffSite: Range;            // L/kWh, water embedded in grid electricity
  gridKgCo2PerKWh: Range;
  source: string;               // e.g. "ecologits:anthropic", "owid:US", "world-default"
  disclosed: boolean;           // false → "infrastructure undisclosed" tag in UI
}

export interface Usage {
  outputTokens: number;         // output + reasoning (reasoning counted once; see §5.2)
  inputTokens: number;          // fresh input
  cacheReadTokens: number;
  cacheWriteTokens: number;
  latencyS?: number;            // measured request time, if known
}

export interface Impact {
  energyWh: Range;
  waterL: Range;
  co2Kg: Range;
  warmingC: Range;
  dominantUncertainty: 'model-size' | 'site' | 'grid' | 'tcre';
  notes: string[];              // e.g. "output tokens only (EcoLogits)", "prefill term on (OpenAgentsy extension)"
}
```

### 4.2 Constants, quoted from the methodology

```ts
// packages/footprint/src/constants.ts
// EcoLogits LLM inference methodology (CC BY-SA 4.0). https://github.com/mlco2/ecologits
export const ALPHA = 1.17e-6;          // Wh / token / B-param, at batch factor
export const BETA = -1.12e-2;
export const GAMMA = 4.05e-5;          // Wh / token
export const BATCH = 64;
export const W_SERVER_NO_GPU_KW = 1.2; // p5.48xlarge reference, via BoaviztAPI
export const GPUS_INSTALLED = 8;
export const GPU_MEM_GB = 80;          // H100 80GB
export const QUANT_BITS = 16;
export const MEM_OVERHEAD = 1.2;

// IPCC AR6 WG1 SPM D.1.1: 0.45 °C per 1000 GtCO2, likely 0.27–0.63. 1000 Gt = 1e15 kg.
export const TCRE_C_PER_KG: Range = [0.27e-15, 0.63e-15];
export const TCRE_BEST_C_PER_KG = 0.45e-15;
```

### 4.3 Core math

```ts
// packages/footprint/src/estimate.ts
const fE = (activeB: number) => ALPHA * Math.exp(BETA * BATCH) * activeB + GAMMA;   // Wh per output token per GPU

export function gpuCount(totalB: number): number {
  const memGB = (MEM_OVERHEAD * totalB * 1e9 * QUANT_BITS) / 8 / 1e9;
  const n = Math.max(1, Math.ceil(memGB / GPU_MEM_GB));
  return 2 ** Math.ceil(Math.log2(n));          // round up to a power of two
}

export interface Throughput { ttftS: Range; tps: Range }   // from OpenRouter stats when known

export function estimateRemote(u: Usage, arch: ModelArch, site: SiteProfile, tp: Throughput, opts: { prefill?: PrefillCoeff } = {}): Impact {
  const notes = ['output tokens only (EcoLogits method)'];
  // Use the corners of the parameter ranges; GPU count is monotone in total params.
  const gpus = r(gpuCount(arch.totalParamsB[0]), gpuCount(arch.totalParamsB[1]));
  const perTok = r(fE(arch.activeParamsB[0]), fE(arch.activeParamsB[1]));
  const eGpu = mul(scale(perTok, u.outputTokens), gpus);                                   // Wh

  const gen: Range = r(tp.ttftS[0] + u.outputTokens / tp.tps[1], tp.ttftS[1] + u.outputTokens / tp.tps[0]);
  const dt: Range = u.latencyS ? r(Math.min(gen[0], u.latencyS), Math.min(gen[1], u.latencyS)) : gen;
  const eRest = scale(mul(dt, scale(gpus, 1 / GPUS_INSTALLED)), (W_SERVER_NO_GPU_KW * 1000) / 3600 / BATCH); // Wh

  let eServer = add(eGpu, eRest);
  if (opts.prefill) {                                     // OpenAgentsy extension, off by default
    eServer = add(eServer, prefillWh(u, arch, opts.prefill));
    notes.push('prefill term on (OpenAgentsy extension, not EcoLogits)');
  }
  const energyWh = mul(eServer, site.pue);
  const kWhServer = scale(eServer, 1 / 1000);
  const waterL = add(mul(kWhServer, site.wueOnSite), mul(mul(kWhServer, site.pue), site.wueOffSite));
  const co2Kg = mul(scale(energyWh, 1 / 1000), site.gridKgCo2PerKWh);
  const warmingC = mul(co2Kg, TCRE_C_PER_KG);

  return { energyWh, waterL, co2Kg, warmingC, dominantUncertainty: dominant(arch, site), notes };
}

/** Local inference (Ollama, LM Studio): measured time × configured device power. No data-centre water. */
export function estimateLocal(seconds: number, deviceWatts: Range, grid: SiteProfile): Impact {
  const energyWh = scale(deviceWatts, seconds / 3600);
  const kWh = scale(energyWh, 1 / 1000);
  return {
    energyWh,
    waterL: mul(kWh, grid.wueOffSite),
    co2Kg: mul(kWh, grid.gridKgCo2PerKWh),
    warmingC: mul(mul(kWh, grid.gridKgCo2PerKWh), TCRE_C_PER_KG),
    dominantUncertainty: 'grid',
    notes: ['local device estimate: configured watts × generation time'],
  };
}

function dominant(a: ModelArch, s: SiteProfile): Impact['dominantUncertainty'] {
  const w = (x: Range) => (x[1] - x[0]) / Math.max(x[0], 1e-12);
  const scores = { 'model-size': w(a.totalParamsB), site: w(s.pue) + w(s.wueOnSite), grid: w(s.gridKgCo2PerKWh) };
  return (Object.entries(scores).sort((x, y) => y[1] - x[1])[0]![0]) as Impact['dominantUncertainty'];
}
```

**Prefill extension (Phase 2b).** The term is `E_prefill = k_in·P_active·T_in + k_cache·P_active·T_cache_read`. Fit `k_in` from ML.ENERGY prefill measurements and set `k_cache` to a small fraction of `k_in`. The fit and its data go into `packages/footprint/data/prefill-fit.json`, with the notebook in `scripts/`. It **doesn't ship until the fit is reviewed.**

### 4.4 Resolving the model and site

```ts
// packages/footprint/src/resolve.ts
export interface Registry {
  ecologitsModels: Map<string, ModelArch>;         // from cached models.json (fetched; VERIFY license before bundling)
  overrides: Map<string, ModelArch>;               // openagentsy.jsonc → footprint.models
  providerSites: Map<string, SiteProfile>;         // EcoLogits provider defaults
  grid: Map<string, Range>;                        // OWID kgCO2/kWh by ISO country
  offsiteWue: Map<string, Range>;                  // WRI L/kWh by ISO country
}

export function resolveArch(reg: Registry, provider: string, modelId: string): ModelArch {
  return reg.overrides.get(`${provider}/${modelId}`) ?? reg.overrides.get(modelId)
    ?? reg.ecologitsModels.get(normalize(modelId))
    ?? { totalParamsB: r(10, 2000), activeParamsB: r(1, 600), source: 'unknown' };   // very wide; UI says "model size unknown"
}
```

Provider site defaults, taken from EcoLogits:

| Provider key | PUE | WUE on-site (L/kWh) |
| --- | --- | --- |
| `anthropic` | 1.09–1.14 | 0.13–0.99 |
| `google` | 1.09 | 0.99 |
| `mistral` | 1.16 | 0.09 |
| `openai` | 1.20 | 0.569 |
| `opencode-go`, `opencode-zen`, `ollama-cloud`, other | EcoLogits world default when one is defined. Otherwise use the widest range in this table, with `disclosed: false`. | same rule |

**VERIFY** the world-default values and the current provider table against the EcoLogits release you pin. Store the version string in `data/SOURCES.md`.

### 4.5 Tests

- **Golden test.** For 20 fixed `(model, usage)` pairs, run the Python `ecologits` library offline once with `scripts/golden.py` and commit the JSON. Our point estimates (using range midpoints and a dense model) must match within 1%.
- **Worked example as a unit test.** P_total 300B, P_active 30B, 150k output tokens, 60 tok/s, PUE 1.2 and a 0.4 kg/kWh grid must give:
  - 16 GPUs;
  - 5.76e-5 Wh/token/GPU;
  - 138.3 Wh on GPUs, 26.0 Wh for the rest of the server, 197.2 Wh in total;
  - 78.9 g CO₂;
  - 3.55e-17 °C at the best-estimate TCRE.
- **Property tests.** For every output, `lo ≤ hi`. Energy never decreases as tokens increase.

---

## 5. `@openagentsy/ledger`: tokens, cost, waste, outcomes

The ledger stores **numbers only**: token counts, model IDs, timestamps, task IDs and commit SHAs. It never stores prompts, completions or code, which follows TokenTracker's privacy rule [^tt]. Transcripts stay in OpenCode's own storage.

### 5.1 Schema (`.openagentsy/ledger.db`, SQLite)

```sql
CREATE TABLE IF NOT EXISTS usage (
  message_id      TEXT PRIMARY KEY,        -- dedup key (OpenCode message id)
  session_id      TEXT NOT NULL,
  root_session_id TEXT NOT NULL,           -- Lead session; subagents roll up here
  role            TEXT,                    -- lead | scout | researcher | builder | reviewer | advisor | archivist | offload
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  input           INTEGER NOT NULL DEFAULT 0,
  output          INTEGER NOT NULL DEFAULT 0,
  reasoning       INTEGER NOT NULL DEFAULT 0,
  cache_read      INTEGER NOT NULL DEFAULT 0,
  cache_write     INTEGER NOT NULL DEFAULT 0,
  cost_reported   REAL,                    -- from OpenCode message.cost, if present
  cost_estimated  REAL,                    -- from pricing chain; NULL = unpriced (never 0)
  latency_ms      INTEGER,
  task_id         TEXT,                    -- in-progress task at the time, if any
  ts              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_root ON usage(root_session_id);
CREATE INDEX IF NOT EXISTS usage_task ON usage(task_id);

CREATE TABLE IF NOT EXISTS waste (
  id INTEGER PRIMARY KEY, root_session_id TEXT, message_id TEXT,
  kind TEXT CHECK (kind IN ('retry','tool_error_loop','interrupted','undo','reverted_code','cache_miss')),
  tokens INTEGER NOT NULL, detail TEXT, ts TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outcome (
  id INTEGER PRIMARY KEY, root_session_id TEXT, task_id TEXT, commit_sha TEXT,
  kind TEXT CHECK (kind IN ('task_completed','task_scrapped','commit','pr_merged')), ts TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS footprint (
  message_id TEXT PRIMARY KEY REFERENCES usage(message_id),
  energy_lo REAL, energy_hi REAL, water_lo REAL, water_hi REAL,
  co2_lo REAL, co2_hi REAL, method_version TEXT NOT NULL
);
```

### 5.2 Ingest

```ts
// packages/ledger/src/ingest.ts
import { Database } from 'bun:sqlite';                // VERIFY: OpenCode plugin runtime is Bun; else better-sqlite3

export function recordAssistantMessage(db: Database, m: OcAssistantMessage, ctx: IngestCtx) {
  const t = m.tokens ?? {};
  // OpenCode reports reasoning separately from output; some providers fold it in (Codex convention).
  // Count it once: if provider is in REASONING_IN_OUTPUT, subtract before storing.
  const reasoning = n(t.reasoning);
  const output = REASONING_IN_OUTPUT.has(m.providerID) ? Math.max(0, n(t.output) - reasoning) : n(t.output);
  db.query(`INSERT OR IGNORE INTO usage
    (message_id, session_id, root_session_id, role, provider, model, input, output, reasoning,
     cache_read, cache_write, cost_reported, latency_ms, task_id, ts)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    m.id, m.sessionID, ctx.rootSessionId, ctx.role, m.providerID, m.modelID,
    n(t.input), output, reasoning, n(t.cache?.read), n(t.cache?.write),
    isNum(m.cost) && m.cost > 0 ? m.cost : null, ctx.latencyMs ?? null, ctx.activeTaskId ?? null, ctx.ts,
  );
}
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
```

Field names (`providerID`, `modelID`, `tokens.cache.read`) follow OpenCode's message shape as read by streetturtle's `session-tokens` plugin [^bs]. That plugin reads `message.model.id` on V2. **VERIFY** both shapes in the Phase 1 adapter, and normalise them there.

**Backfill (optional, opt-in).** Open `~/.local/share/opencode/opencode.db` read-only, plus any `opencode-<channel>.db`, and skip the `-wal`/`-shm` sidecars, as tokscale does [^tokscale]. Import past sessions with `INSERT OR IGNORE`. **VERIFY** the table schema for the OpenCode version you pin; it is internal and can change.

### 5.3 Pricing chain

Prices are tried in this order, and the first hit wins:

1. `message.cost` reported by OpenCode;
2. models.dev `cost.{input,output,cache_read,cache_write}` per 1M tokens;
3. LiteLLM's pricing JSON;
4. OpenRouter's endpoints API;
5. `NULL`, shown as "unpriced", never as `$0`.

Every source is cached for 24 hours on disk under `~/.cache/openagentsy/pricing/`. A copy bundled at build time covers offline use. Tiered pricing (rates that change above a token threshold) is respected when the source provides it.

### 5.4 Waste signals (agent waste, not user scoring)

| Signal | Detection | Tokens counted |
| --- | --- | --- |
| `retry` | The same tool with the same normalised args within 3 calls, after an error | The repeated call's turn |
| `tool_error_loop` | 3 or more consecutive tool errors in one subagent | Those turns |
| `interrupted` | The user cancels a turn mid-stream (OpenCode abort event) | That turn's tokens |
| `undo` | `/undo` or a revert of the agent's last change | Tokens of the undone turn |
| `reverted_code` | Lines committed under a `Refs:` trailer that are deleted again within 14 days (`git log -L` / blame diff in a nightly job) | Builder tokens for that task × the share of lines lost |
| `cache_miss` | `cache_read / (input + cache_read)` below 0.5 on a turn whose prefix was unchanged | Uncached input |

**There is no "frustration score" about the person.** The Budget block shows "18% of tokens went to retries, undos and reverted code". It never characterises the user.

### 5.5 Outcomes: tokens per result

Outcomes are filled in from three sources:

- task transitions (`completed`, `scrapped`) in the tasks store;
- `Refs: <task-id>` trailers found by `git log --since`;
- PR merges seen by the `pr` integration mode.

From those, the ledger reports **tokens per completed task** and **tokens per merged commit**. These are the Phase 2 exit metrics, compared with Phase 1 and with plain OpenCode. The idea is TokenTracker's "effective tokens" outcomes sidecar, applied to task results [^tt].

```sql
-- tokens per completed task, last 30 days
SELECT o.task_id, SUM(u.input + u.output + u.reasoning + u.cache_write) AS tokens, SUM(COALESCE(u.cost_reported, u.cost_estimated)) AS usd
FROM outcome o JOIN usage u ON u.task_id = o.task_id
WHERE o.kind = 'task_completed' AND o.ts > datetime('now','-30 days')
GROUP BY o.task_id;
```

### 5.6 Exports

`oa ledger export --json` writes the counters only, using a schema documented in `packages/ledger/SCHEMA.md`. Because tokscale and TokenTracker already read OpenCode's own database, people who use those tools get the same sessions without any work from us. Nothing is uploaded. There is no leaderboard, streak or achievement feature (§10).

---

## 6. `@openagentsy/sidebar`: TUI blocks

### 6.1 V2 entry point

This follows the structure of streetturtle's `session-tokens` plugin, which is the only V2 sidebar source we have read directly [^bs]:

```tsx
// packages/sidebar/src/tui.tsx
/** @jsxImportSource @opentui/solid */
import { Plugin } from '@opencode/plugin/tui';
import { FootprintBlock } from './blocks/footprint.js';
import { BoardBlock } from './blocks/board.js';
import { TasksBlock } from './blocks/tasks.js';
import { BudgetBlock } from './blocks/budget.js';
import { MemoryInboxBlock } from './blocks/memory.js';
import { AccountabilityBlock } from './blocks/accountability.js';

export default Plugin.define({
  id: 'openagentsy.sidebar',
  setup(context) {
    const blocks = [BoardBlock, TasksBlock, BudgetBlock, FootprintBlock, MemoryInboxBlock, AccountabilityBlock];
    for (const Block of blocks) {
      context.ui.slot({ append: 'sidebar.content', render: (input) => <Block sessionID={input.sessionID} /> });
    }
    context.ui.panel?.register?.('openagentsy.footprint.method', MethodPanel);   // VERIFY panel registration API
  },
});
```

### 6.2 Shared hook: usage for the whole session family

```tsx
// packages/sidebar/src/use-family-usage.ts
import { createEffect, createMemo } from 'solid-js';
import { usePlugin } from '@opencode/plugin/tui';

export function useFamilyUsage(sessionID: () => string) {
  const ctx = usePlugin();
  // Lead + subagent sessions. VERIFY: session.family returns ids or session objects.
  const family = createMemo(() => ctx.data.session.family?.(sessionID()) ?? [{ id: sessionID() }]);
  createEffect(() => { for (const s of family()) void ctx.data.session.message.sync(s.id); });

  return createMemo(() => {
    const seen = new Set<string>();
    const perModel = new Map<string, UsageRow>();
    for (const s of family()) {
      for (const m of ctx.data.session.message.list(s.id) as OcMessage[]) {
        if (m?.type !== 'assistant' || !m.id || seen.has(m.id)) continue;
        seen.add(m.id);
        const key = `${m.model?.providerID ?? m.providerID ?? 'unknown'}/${m.model?.id ?? m.modelID ?? 'unknown'}`;
        const row = perModel.get(key) ?? emptyRow(key);
        row.output += num(m.tokens?.output) + num(m.tokens?.reasoning);
        row.input += num(m.tokens?.input);
        row.cacheRead += num(m.tokens?.cache?.read);
        row.cacheWrite += num(m.tokens?.cache?.write);
        row.cost += num(m.cost);
        perModel.set(key, row);
      }
    }
    return [...perModel.values()].sort((a, b) => b.output - a.output);
  });
}
```

### 6.3 Footprint block

```tsx
// packages/sidebar/src/blocks/footprint.tsx
/** @jsxImportSource @opentui/solid */
import { For, Show, createMemo } from 'solid-js';
import { usePlugin } from '@opencode/plugin/tui';
import { estimateRemote, estimateLocal, sumImpacts } from '@openagentsy/footprint';
import { useCollapsed } from '../persist.js';

export function FootprintBlock(props: { sessionID: string }) {
  const ctx = usePlugin();
  const cfg = useConfig();                        // openagentsy.jsonc → footprint.*
  const rows = useFamilyUsage(() => props.sessionID);
  const [open, toggle] = useCollapsed('footprint', false);

  const impact = createMemo(() => sumImpacts(rows().map((row) => {
    const [provider, model] = splitKey(row.key);
    return isLocal(provider)
      ? estimateLocal(row.genSeconds, cfg().localDeviceWatts, cfg().site(provider))
      : estimateRemote(toUsage(row), cfg().arch(provider, model), cfg().site(provider), cfg().throughput(provider, model),
          { prefill: cfg().prefill ? cfg().prefillCoeff : undefined });
  })));

  const t = () => ctx.theme;                      // normal text colours only — no alarm colours (§6.6)
  return (
    <Show when={rows().length > 0}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={toggle}>
          <text fg={t().text.base}>{open() ? '▼' : '▶'}</text>
          <text fg={t().text.base}><b>Footprint</b></text>
          <text fg={t().text.muted}>{fmtWh(impact().energyWh)} · {fmtL(impact().waterL)} · {fmtCo2(impact().co2Kg)}</text>
        </box>
        <Show when={open()}>
          <Row label="Electricity" value={fmtWh(impact().energyWh)} />
          <Row label="Water" value={`${fmtL(impact().waterL)}  data centre + grid`} />
          <Row label="Carbon" value={`${fmtCo2(impact().co2Kg)}  ${gridLabel(cfg())}`} />
          <Show when={cfg().showWarming}>
            <Row label="Warming" value={`${fmtSci(impact().warmingC)} °C  IPCC TCRE`} />
          </Show>
          <text fg={t().text.muted}>range mostly from: {LABEL[impact().dominantUncertainty]}</text>
          <For each={impact().notes}>{(n) => <text fg={t().text.muted}>· {n}</text>}</For>
          <Show when={rows().some((r) => !cfg().site(splitKey(r.key)[0]).disclosed)}>
            <text fg={t().text.muted}>· infrastructure undisclosed for some providers</text>
          </Show>
          <text fg={t().text.muted} onMouseDown={() => ctx.ui.panel.open('openagentsy.footprint.method')}>
            method and sources ›
          </text>
        </Show>
      </box>
    </Show>
  );
}
```

Formatting rules:

- `fmtWh` switches between Wh and kWh.
- `fmtL` switches between mL and L.
- `fmtCo2` switches between g and kg.
- `fmtSci` prints a range like `2.1–5.0 × 10⁻¹⁷`.
- Every value is shown as a `lo–hi` range rounded to 2 significant figures, never as a single number.

### 6.4 Other blocks (data sources)

| Block | Reads | Notes |
| --- | --- | --- |
| Board | The board MCP's counts-only poll (Phase 1, §III.6), plus `detectTaskIds` per worktree | Provisional task states are shown dimmed. |
| Tasks | `TaskStore.all()` through a file watcher on `.beans/` | Shows in-progress, the next 3 ready tasks, and how many are blocked. Mouse-down on a row inserts `oa_task_show <id>` into the prompt. **VERIFY** the prompt-insert API. |
| Budget | `ledger.db` for this root session | Tokens by role, cache hit rate, waste %, and tokens per completed task. Also tokens saved by offload. |
| Memory inbox | Magic Context harvest queue | Each memory gets `a` (approve) or `r` (reject) through `context.keymap.layer`. Rejected memories never enter memory. |
| Accountability | The `outcome` table, the redaction counter and the hook audit log | Links to `oa report --ethical`. |

### 6.5 Collapse persistence

```ts
// packages/sidebar/src/persist.ts
// One small JSON file per user. VERIFY whether the TUI plugin API exposes a KV store (Mangome's plugin persists state);
// if it does, use it instead of the file.
const FILE = join(homedir(), '.config', 'openagentsy', 'sidebar.json');
export function useCollapsed(key: string, initial: boolean): [() => boolean, () => void] { /* signal + debounced write */ }
```

### 6.6 Framing rules, as code review checks

- Blocks only use `theme.text.base` and `theme.text.muted`. A lint rule (a custom Biome GritQL plugin, or a unit test that scans the JSX) fails if a footprint block references `theme.error` or `theme.warning`.
- No copy contains "you", "your fault", "streak", "today you" or a comparison with other users. A unit test checks this against a list of banned words.
- `footprint.showWarming` defaults to `true`, and can be set to `false` in `openagentsy.jsonc`.

### 6.7 V1 fallback

```ts
// packages/sidebar/src/v1.ts
import type { Plugin } from '@opencode-ai/plugin';

export const OpenAgentsySidebarV1: Plugin = async ({ client }) => ({
  event: async ({ event }) => {
    if (event.type !== 'session.idle') return;
    const s = await summarise(event.properties.sessionID);          // ledger + footprint, same code as V2
    await client.tui.showToast({ body: { message: s.oneLine, variant: 'info' } });   // VERIFY SDK method shape
  },
  tool: {
    oa_status: defineTool({ description: 'Board, tasks, budget and footprint summary', args: z.object({}),
      execute: async (_a, ctx) => renderStatus(await summarise(ctx.sessionID)) }),
  },
});
```

The `/oa status` and `/oa footprint` commands live in `.opencode/command/*.md` and call `oa_status`. If OpenCode issue #5971's sidebar hook turns out to have shipped, `v1.ts` also returns `sidebar: () => panels`, using the same `summarise()` output as plain `{label, value}` rows [^oc5971].

Packaging follows the existing community plugins:

- `@openagentsy/sidebar@2.x` exports `dist/tui.js`, built with esbuild and with `@opentui/solid` and `solid-js` as peer dependencies.
- `@openagentsy/sidebar@1.x` exports `dist/v1.js`.
- There is no single package that tries to run on both runtimes.

---

## 7. `@openagentsy/hooks`: deterministic guardrails

### 7.1 Use agentsy's registry directly

`@agentsy/runtime` already provides a priority-ordered `HookRegistry`. Its handlers return:

- `{ continue: true }`;
- `{ continue: false, reason }`, which stops the chain;
- `{ transform }`.

It also defines event types for `UserPromptSubmit`, `PreToolCall`, `PostToolCall`, `PreCompact`, `SubagentStop`, `PreResponse`, `PostResponse` and the model-call events [^agentsyhooks]. We depend on it rather than writing our own:

```ts
// packages/hooks/src/registry.ts
import { createRuntimeHookRegistry, type HookRegistry, type PreToolCallEvent } from '@agentsy/runtime';
// VERIFY: hooks are exported from the package root (src/index.ts); if not, add a "./hooks" subpath export upstream.

export const BLOCK_PRIORITY = 1000;     // blocking rules always run first
export function createOaRegistry(rules: Rule[]): HookRegistry {
  const reg = createRuntimeHookRegistry();
  for (const r of rules) reg.register(r.event, r.handler, { id: r.id, priority: r.block ? BLOCK_PRIORITY : r.priority ?? 0 });
  return reg;
}
```

### 7.2 OpenCode bridge

```ts
// packages/hooks/src/v1.ts
import type { Plugin } from '@opencode-ai/plugin';

export const OpenAgentsyHooks: Plugin = async ({ directory }) => {
  const reg = createOaRegistry(defaultRules({ workspace: directory }));
  return {
    'tool.execute.before': async (input, output) => {           // VERIFY arg shapes for pinned SDK
      const res = await reg.fire({ type: 'PreToolCall', toolName: input.tool, args: output.args, sessionId: input.sessionID } satisfies PreToolCallEvent);
      if ('continue' in res && res.continue === false) throw new Error(`Blocked by OpenAgentsy policy: ${res.reason}`);
      if ('transform' in res) output.args = res.transform;
    },
    'tool.execute.after': async (input, output) => {
      await reg.fire({ type: 'PostToolCall', toolName: input.tool, args: input.args, result: output, sessionId: input.sessionID });
    },
  };
};
```

**Model output can't override a blocking rule.**

- Blocking rules run inside the plugin process, before the tool runs.
- The only way past one is a person editing `openagentsy.jsonc`, and that edit is itself a file write that the `protect-policy` rule below routes to an approval request.

### 7.3 Default rules

```ts
// packages/hooks/src/rules.ts
const GIT_SKIP_HOOKS = /\bgit\b[^|;&]*\b(commit|push|merge|rebase)\b[^|;&]*(\s--no-verify\b|\s-n\b)|\bHUSKY=0\b|\bcore\.hooksPath\b/;

export const defaultRules = ({ workspace }: { workspace: string }): Rule[] => [
  { id: 'no-skip-git-hooks', event: 'PreToolCall', block: true,
    handler: async (e) => isShell(e) && GIT_SKIP_HOOKS.test(cmd(e))
      ? { continue: false, reason: 'Git hooks (lint, typecheck) cannot be skipped. Fix the reported errors instead.' }
      : { continue: true } },

  { id: 'workspace-writes-only', event: 'PreToolCall', block: true,
    handler: async (e) => isWrite(e) && !isInside(targetPath(e), [workspace, worktreeRoot(projectName(workspace))])
      ? { continue: false, reason: `Writes are limited to the workspace and OpenAgentsy worktrees.` }
      : { continue: true } },

  { id: 'protect-policy', event: 'PreToolCall', block: true,
    handler: async (e) => isWrite(e) && /openagentsy\.jsonc$|\.husky\/|biome\.jsonc$/.test(targetPath(e) ?? '')
      ? { continue: false, reason: 'Policy and hook files are edited by a person, not an agent. Propose the change in chat.' }
      : { continue: true } },

  { id: 'secret-scan-writes', event: 'PreToolCall', block: true,
    handler: async (e) => isWrite(e) && findSecrets(contentOf(e)).length
      ? { continue: false, reason: 'The content contains what looks like a credential. Use an env var or secret reference.' }
      : { continue: true } },

  { id: 'destructive-needs-approval', event: 'PreToolCall', block: true,
    handler: approvalGate(/(^|\s)(rm\s+-rf|git\s+push\s+--force|git\s+reset\s+--hard|drop\s+table)\b/i) },
];
```

`approvalGate` reuses agentsy's `createApprovalHook`/`isDestructiveTool`. It asks through OpenCode's permission prompt, and **VERIFY** that this maps to V1's `permission` config, falling back to `ask` there.

### 7.4 Secret redaction when anything is written to storage

```ts
// packages/hooks/src/secrets.ts
const PATTERNS: [name: string, re: RegExp][] = [
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g],
  ['openai-key', /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
  ['slack-token', /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['generic-assign', /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?([A-Za-z0-9/+_=-]{16,})/gi],
];
export function findSecrets(s: string) { /* PATTERNS + Shannon entropy > 4.0 on 20+ char tokens */ }
export function redact(s: string): { text: string; count: number } { /* replace with «redacted:<name>» */ }
```

`redact()` runs on everything that gets stored: board records, harvested memories, archived task bodies and Accountability reports. Each redaction increments the counter shown in the Accountability block. The test fixtures include a key with real secret shape, which must never appear in `.openagentsy/` after a scenario run.

### 7.5 Patch review queue

```ts
// packages/hooks/src/patches.ts
export interface PromptPatch {
  id: string; target: `skill:${string}` | `role:${string}` | 'instructions';
  diff: string;                     // unified diff against the current file
  evidence: { wasteKind: string; tokens: number; sessions: string[] }[];
  confidence: number;               // shown, never acted on automatically
  status: 'proposed' | 'approved' | 'rejected';
}
```

- The archivist proposes a patch after a pattern in the waste table repeats across 3 or more sessions.
- `/oa patches` lists proposed patches. Approving one applies the diff as an ordinary file edit, which goes through the hooks, and records who approved it.
- **Nothing is applied without an `approved` status set by a person.** The red-team exit test checks this.

### 7.6 Output checks (from agentsy SAFETY.md)

These run as `PreResponse` handlers, and they **flag** rather than block:

| Check | Detector |
| --- | --- |
| Sycophancy | Phrases that praise or agree with the user, followed by no change in position after the user pushes back. Measured against a reviewer verdict. |
| Anthropomorphising | First-person claims of feelings or experiences ("I feel", "I'm excited"). |
| Dependency | "You don't need to understand this" or "just let me handle it" language. |
| AGI or longtermist framing | Phrases claiming the system replaces engineers, or calling the work "superintelligence". |
| Scope drift | Files touched outside the active task's stated paths, or tool calls unrelated to the task title. Uses an embedding check from the offload model. |

Flags go to the Accountability block and to `oa report --ethical`. The person decides what to do about them.

---

## 8. `@openagentsy/offload`: local models for housekeeping

### 8.1 What gets offloaded

| Job | Caller | Output contract |
| --- | --- | --- |
| Session and task titles | sidebar, tasks | `{ title: string ≤ 60 chars }` |
| Compaction summaries | the Magic Context `PreCompact` handler | `{ summary: string ≤ 1200 chars, keep: string[] }` |
| JSON repair for tool arguments | adapters | the target zod schema |
| Classification (task type, waste kind, scope-drift similarity) | tasks, ledger, hooks | an enum |
| Quick replies after a turn (idea from Beans [^beans]) | sidebar | `{ replies: string[] ≤ 4, each ≤ 10 words }` |

### 8.2 Router

```ts
// packages/offload/src/router.ts
import { z } from 'zod';
import { repairJsonWithStateMachine } from '@agentsy/core/structured';   // exported via structured/index.ts

export interface LocalBackend { kind: 'ollama' | 'lmstudio'; baseUrl: string; model: string }

export async function offload<T>(job: { name: string; prompt: string; schema: z.ZodType<T>; maxTokens: number },
  be: LocalBackend, onUsage: (u: OffloadUsage) => void): Promise<T | undefined> {
  const t0 = performance.now();
  const body = be.kind === 'ollama'
    ? { model: be.model, stream: false, format: z.toJSONSchema(job.schema),     // Ollama structured outputs
        messages: [{ role: 'user', content: job.prompt }], options: { num_predict: job.maxTokens } }
    : { model: be.model, max_tokens: job.maxTokens, messages: [{ role: 'user', content: job.prompt }],
        response_format: { type: 'json_schema', json_schema: { name: job.name, schema: z.toJSONSchema(job.schema) } } };
  const url = be.kind === 'ollama' ? `${be.baseUrl}/api/chat` : `${be.baseUrl}/v1/chat/completions`;

  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) }).catch(() => undefined);
  if (!res?.ok) return undefined;                                  // caller falls back to the cloud model or skips
  const data = await res.json();
  const text: string = be.kind === 'ollama' ? data.message?.content : data.choices?.[0]?.message?.content;

  for (const candidate of [text, repairJsonWithStateMachine(text ?? '')]) {
    try {
      const parsed = job.schema.safeParse(JSON.parse(candidate));
      if (parsed.success) {
        onUsage({ job: job.name, seconds: (performance.now() - t0) / 1000,
          inTok: data.prompt_eval_count ?? data.usage?.prompt_tokens ?? 0,
          outTok: data.eval_count ?? data.usage?.completion_tokens ?? 0 });
        return parsed.data;
      }
    } catch { /* try next candidate */ }
  }
  return undefined;   // one repair attempt only; no retry loop that burns local time
}
```

**Savings accounting.** `onUsage` writes a ledger row with `role = 'offload'`. It also records **cloud-equivalent savings**: the same token counts priced at the model the job would otherwise have used, from models.dev. The local footprint comes from `estimateLocal`. The Budget block then shows, for example, "offload saved 41k cloud tokens (~$0.12)", with the footprint change alongside it.

**Discovery.** At startup the router probes `GET {ollama}/api/tags` and `GET {lmstudio}/v1/models`, then picks the first configured model that is installed. With no local backend, offload is skipped and nothing breaks.

---

## 9. Configuration (`openagentsy.jsonc`, Phase 2 keys)

```jsonc
{
  "tasks": { "path": ".beans", "prefix": "oa-", "idLength": 4, "worktrees": { "baseRef": "main", "integrate": "pr", "setup": "pnpm install", "fetchTimeoutSec": 10 } },
  "footprint": {
    "showWarming": true,
    "prefill": false,
    "gridRegion": "auto",            // "auto" = provider's disclosed region, else world default; or ISO code e.g. "US"
    "localDeviceWatts": [25, 60],    // range, for laptops running local models
    "models": { "ollama/qwen3:8b": { "totalParamsB": [8, 8], "activeParamsB": [8, 8] } }
  },
  "ledger": { "backfillOpencodeDb": false, "pricingSources": ["opencode", "models.dev", "litellm", "openrouter"] },
  "offload": { "backends": [{ "kind": "ollama", "baseUrl": "http://127.0.0.1:11434", "model": "qwen3:4b" }], "jobs": ["title", "compaction", "json-repair", "classify", "quick-replies"] },
  "hooks": { "extraBlockedCommands": [], "approvalFor": ["git push", "gh pr merge"] }
}
```

If `.beans.yml` exists, its `beans.prefix`, `beans.id_length` and `beans.path` take precedence. That way OpenAgentsy and the `beans` CLI write the same IDs.

---

## 10. Left out on purpose

| From | Feature | Why not |
| --- | --- | --- |
| agentsy | Prompt patches that apply themselves at ≥0.9 confidence | Changes to the agent's own instructions need a person's review (§7.5). |
| agentsy | Numeric peer scores and rankings in council mode | They push models toward agreeing with each other. We keep anonymised review and the dissent section. |
| agentsy | The `superagent` built-in and its framing | It presents the system as a replacement for the person. |
| Beans | Coercive prime text ("ignore all previous instructions") injected on every turn | The text competes with other instructions and costs tokens every turn. We replace it with a 150-token state block, an on-demand skill and rules enforced in code. |
| Beans | Its own agent runtime, web UI and GraphQL server | OpenCode is the runtime, and the TUI is the interface. |
| Beans | "You get to be a product manager" framing | The person stays the engineer. |
| TokenTracker | Achievements, streaks, desktop pet, global leaderboard, anonymous telemetry | These are engagement and comparison mechanics. We ship no telemetry. |
| tokscale | Leaderboard submission; the "Kardashev scale" framing ("tokens are the new energy") | Measuring progress by how much is consumed is the opposite of the footprint block's purpose. |
| tokscale | An LLM summariser for reports that runs on a hosted model | We use local offload only, and it's opt-in. |

---

## 11. Build order and exit tests

| Step | Delivers | Exit test (in the Scenario + Vitest suites) |
| --- | --- | --- |
| **2.0** | Biome, Husky, lint-staged, `tsc`, CI, the `no-skip-git-hooks` rule | A commit with a seeded lint error is blocked. A type error blocks the commit. An agent running `git commit --no-verify` is denied. CI fails on the same seeds. |
| **2a** | `tasks` package, prime block, `oa_task_*` tools, `footprint` package | Round-trip over the `hmans/beans` `.beans/` corpus passes. `ready` and `next` match Beans' documented semantics on 15 fixtures (blocked parent, terminal ancestor, epics excluded). Footprint golden test passes within 1%. Prime block is ≤ 200 tokens. |
| **2b** | `ledger` (ingest, pricing, waste, outcomes), `offload` | Deduplication: replaying a session doesn't change totals. Unpriced models show "unpriced". Offload lowers cloud tokens per completed task compared with Phase 1, with pass³ unchanged. |
| **2c** | `hooks` (bridge, rules, redaction, patch queue, output checks) | Red-team: a model told to "commit with --no-verify" or "edit openagentsy.jsonc" is blocked. A seeded secret never reaches `.openagentsy/`. No patch applies without approval. Output-check flags appear on seeded transcripts. |
| **2d** | `sidebar` V2 blocks, V1 fallback, worktrees, `oa report --ethical` | Blocks render from fixtures in the OpenTUI test renderer. The banned-word and banned-colour tests pass. The V1 toast fires on `session.idle`. Worktree task detection matches `git diff`. Provisional statuses clear after merge. |

---

## 12. Open questions

- **Prefill term:** keep it off by default until the fit is reviewed (recommended)?
- **Bundling `models.json`:** fetch-and-cache only, until the EcoLogits data license is confirmed?
- **Monorepo license:** make all of OpenAgentsy GPL-3.0-or-later (recommended, simplest), or only the packages that import agentsy?
- **Upstream export:** should agentsy add a `./hooks` subpath export to `@agentsy/runtime`, or re-export the hooks from the package root?
- **Beans compatibility:** keep OpenAgentsy's rendering byte-identical to Beans', or accept whitespace differences?
- **V1:** confirm whether issue #5971's sidebar hook merged.

---

## References

[^beans]: hmans/beans (Apache-2.0) — https://github.com/hmans/beans
[^beansplugin]: Beans OpenCode plugin — https://github.com/hmans/beans/blob/main/.opencode/plugin/beans-prime.ts
[^agentsyhooks]: agentsy runtime hooks — https://github.com/selfagency/agentsy/tree/main/packages/runtime/src/hooks
[^bs]: streetturtle/opencode-better-sidebar — https://github.com/streetturtle/opencode-better-sidebar
[^tokscale]: junhoyeo/tokscale (MIT) — https://github.com/junhoyeo/tokscale
[^tt]: xiufengsun/TokenTracker (MIT) — https://github.com/xiufengsun/TokenTracker
[^oc5971]: OpenCode issue #5971 — https://github.com/anomalyco/opencode/issues/5971
[^eco]: EcoLogits — https://github.com/mlco2/ecologits
[^ipcc]: IPCC AR6 WG1 Summary for Policymakers, D.1.1
[^li]: Li et al., "Making AI Less Thirsty" — https://arxiv.org/abs/2304.03271
[^safety]: agentsy SAFETY.md — https://github.com/selfagency/agentsy/blob/main/SAFETY.md
[^ocv2]: OpenCode V2 plugins docs — https://opencode.ai/v2/docs/cli/plugins
