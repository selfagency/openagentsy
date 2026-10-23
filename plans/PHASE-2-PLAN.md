# OpenAgentsy Phase 2: Implementation Plan

**Bottom line.** Phase 2 ships seven packages and two cross-cutting features:

- **`@openagentsy/tasks`.** A built-in task tracker that reads and writes the Beans `.beans/` Markdown format directly. It needs neither `beans-mcp` nor the `beans` CLI.
- **`@openagentsy/footprint`.** Energy, water, carbon and warming estimates using the EcoLogits method. Every number carries a range.
- **`@openagentsy/ledger`.** A local SQLite ledger of tokens and cost per message. It also records waste signals and outcomes: tokens per completed task and per commit.
- **`@openagentsy/hooks`.** Deterministic guardrails built on agentsy's `HookRegistry`, plus:
  - secret redaction;
  - a **lesson lifecycle** with executable eval artifacts, which replaces the patch queue (§7.5);
  - the **Lead recovery loop** (§7.7).
- **`@openagentsy/offload`.** Routes small housekeeping jobs (titles, summaries, JSON repair, quick replies) to a local model.
- **`@openagentsy/sidebar`.** The OpenCode V2 TUI sidebar blocks, with a toast and slash-command fallback for V1.
- **`@openagentsy/quality`.** The anti-slop checks:
  - static CSS, HTML, copy and comment checks in code;
  - optional Hallmark `sloplint`;
  - recorded waivers;
  - three on-demand skills;
  - a reviewer gate (§9).
- **`oa conformance`.** Reports, per host version, which OpenCode capabilities are proven, observed or unverified (§10).

Before any of that, step 2.0 **moves the repo from pnpm to Bun workspaces with Turborepo** (§1). The Biome, Husky, lint-staged, `tsc` and CI baseline stays as it is; only the commands that run it change. OpenCode loads plugins with Bun, so this also means one runtime for development, tests and production.

Code below is TypeScript in the style of the Phase 1 codebase. Where an OpenCode API detail is inferred rather than read from source, it's marked **VERIFY**. Every **VERIFY** maps to one conformance check.

---

## 0. Licensing

Phase 2 reuses code from agentsy (GPL-3.0-or-later; the MIT mention in its README is stale), so **the OpenAgentsy packages that import it must be GPL-3.0-or-later.** The simplest option is to license the whole monorepo GPL-3.0-or-later. The other sources are compatible:

| Source | License | How we use it |
| --- | --- | --- |
| agentsy (`@agentsy/runtime` hooks, `@agentsy/core/structured`) | GPL-3.0-or-later | Imported as a dependency. |
| hmans/beans | Apache-2.0 | File format re-implemented. Fractional-index algorithm ported, with an attribution header and NOTICE entry (Apache-2.0 code may go into GPL-3 works). |
| junhoyeo/tokscale | MIT | Ideas only: OpenCode DB discovery, pricing fallback chain, dedup rules. |
| xiufengsun/TokenTracker | MIT | Ideas only: outcomes sidecar, git attribution, privacy rules. |
| zhaono1/agent-playbook | MIT | Lesson states, start packet and eval-artifact contract adapted; long-task recovery loop and host-conformance states adapted. No package or MCP dependency. Attribution headers and NOTICE entry. |
| miqdadbadjuber/anti-slop | MIT | Rules adapted into code and skills, keeping their `R-XX` IDs in rule metadata. Attribution headers and NOTICE entry. |
| Nutlope/hallmark | MIT | Floor rules adapted, keeping their Floor numbers. `sloplint.mjs` is called as an external check when installed, not vendored. |
| EcoLogits methodology | CC BY-SA 4.0 (docs) | Formulas re-implemented, with credit in the UI and README. **VERIFY** the license of `ecologits/data/models.json` before bundling it. Until then, fetch it at runtime and cache it. |

```jsonc
// package.json (root)
{ "license": "GPL-3.0-or-later" }
```

---

## 1. Step 2.0: pnpm → Bun workspaces + Turborepo

**Why now.**
- **One runtime.** OpenCode loads plugins with Bun: the plugin's `$` is Bun's shell, and OpenCode runs `bun install` in its config directories [^tai]. Developing and testing on Bun removes a Node/Bun gap from every plugin.
- **`bun:sqlite`** becomes the ledger driver everywhere (§5.2).
- **Turborepo** caches each package's lint, typecheck, test and build. Turborepo 2.6 made Bun support stable and parses `bun.lock` v1 per package. Changing one package's dependencies now invalidates only that package's cache, not the whole repo's [^turbo26]. Bun supports pnpm-style workspaces, catalogs and isolated installs [^bunws].

**What stays the same.** Biome, Husky, lint-staged and `tsc` don't change; only the commands that run them do.

### 1.1 Root files

```jsonc
// package.json (root)
{
  "name": "openagentsy",
  "private": true,
  "license": "GPL-3.0-or-later",
  "packageManager": "bun@1.3.x",            // VERIFY exact pin; turbo reads this field to detect the package manager
  "workspaces": {
    "packages": ["packages/*"],
    "catalog": {                             // was pnpm-workspace.yaml `catalog:`; same `catalog:` protocol in package.json deps
      "zod": "^4", "solid-js": "^1.9", "typescript": "^5.9", "vitest": "^3"
    }
  },
  "scripts": {
    "prepare": "husky",
    "lint": "biome check .",
    "format": "biome format --write .",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test",
    "build": "turbo run build",
    "check": "turbo run lint typecheck test build"
  },
  "lint-staged": {
    "*.{ts,tsx,js,jsx,json,jsonc,css}": ["biome check --write --no-errors-on-unmatched"]
  },
  "devDependencies": { "turbo": "^2.6", "@biomejs/biome": "…", "husky": "…", "lint-staged": "…" }
}
```

```toml
# bunfig.toml
[install]
linker = "isolated"     # pnpm-like strict node_modules; the default for workspaces migrated from pnpm (configVersion 1)
exact = true            # `bun add` pins exact versions; ranges stay in the catalog
# hoist = false         # stricter still: undeclared imports fail. Turn on once phantom imports are fixed (§1.4)
```

```jsonc
// turbo.json
{
  "$schema": "https://turborepo.com/schema.json",
  "ui": "tui",
  "tasks": {
    "build":     { "dependsOn": ["^build"], "inputs": ["src/**", "package.json", "tsconfig*.json"], "outputs": ["dist/**"] },
    "typecheck": { "dependsOn": ["^build"], "inputs": ["src/**", "test/**", "tsconfig*.json"], "outputs": [] },
    "test":      { "dependsOn": ["^build"], "inputs": ["src/**", "test/**", "fixtures/**"], "outputs": [] },
    "//#lint":   { "inputs": ["**/*.{ts,tsx,js,json,jsonc,css}", "biome.jsonc"], "outputs": [] }
  },
  "globalDependencies": ["biome.jsonc", "tsconfig.base.json", "bunfig.toml"]
}
```

`//#lint` is a root task, because Biome checks the whole repo in one pass. Each package defines `build`, `typecheck` (`tsc --noEmit -p .`) and `test`.

**Per-package scripts.**

```jsonc
// packages/<name>/package.json
{
  "scripts": {
    "build": "bun build src/index.ts --outdir dist --target bun --packages external && tsc -p tsconfig.build.json --emitDeclarationOnly",
    "typecheck": "tsc --noEmit -p .",
    "test": "vitest run"
  },
  "engines": { "opencode": ">=1.19 <2" }   // OpenCode skips npm plugins whose engines.opencode excludes the running version [^tai]
}
```

- **Sidebar exception.** `packages/sidebar` keeps its Solid JSX transform for `dist/tui.js` (§6.7). **VERIFY** whether `@opentui/solid`'s Bun plugin works with `bun build`; if not, keep esbuild with `babel-preset-solid` for that one package.
- **Tests stay on Vitest**, so existing suites don't need rewriting. `bun test` is an option later; it isn't part of this step.

### 1.2 Hooks and CI

```sh
# .husky/pre-commit
bunx lint-staged
bun run typecheck      # turbo: only packages affected by the change re-run; the rest hit cache
```

```yaml
# .github/workflows/ci.yml (job steps)
- uses: oven-sh/setup-bun@v2
  with: { bun-version-file: package.json }   # reads packageManager; VERIFY input name for the pinned action version
- run: bun install --frozen-lockfile
- run: bunx turbo run lint typecheck test build
  env: { TURBO_TELEMETRY_DISABLED: "1" }
```

- **No telemetry, here or locally.** `TURBO_TELEMETRY_DISABLED=1` goes in CI, in the agent shell environment (§7.3) and in `CONTRIBUTING.md`. That matches the rest of OpenAgentsy.
- **Remote caching stays off.** It needs a Vercel account or a self-hosted cache, and it uploads build artifacts. It's opt-in only (§12).

### 1.3 Migration steps

1. **Pin Bun.** Add `packageManager` and a `.bun-version` file, plus `mise`/`asdf` config if the repo uses one.
2. **Move the workspace definition.** Copy `pnpm-workspace.yaml`'s `packages` and `catalog` into the root `package.json` (§1.1). Keep the `workspace:*` and `catalog:` specifiers, which Bun reads unchanged.
3. **Migrate the lockfile.** Run `bun install`, which converts `pnpm-lock.yaml` into a text `bun.lock`. **VERIFY** the resolved versions with `bun pm ls --all` against `pnpm list -r --depth Infinity`, and review any differences before deleting the old lockfile.
4. **Port pnpm-specific settings:**
   - `pnpm.overrides` → `overrides`;
   - `pnpm.patchedDependencies` → `patchedDependencies` (re-run `bun patch` for each one);
   - `onlyBuiltDependencies` → `trustedDependencies`. Bun skips dependencies' lifecycle scripts unless they're trusted. List only the packages that need them, such as esbuild.
   - Registry and auth entries in `.npmrc` stay. Bun reads them.
5. **Delete** `pnpm-lock.yaml`, `pnpm-workspace.yaml`, any `.pnpmfile.cjs`, and pnpm-only `.npmrc` keys. Add `.turbo/` to `.gitignore`.
6. **Add Turborepo.** Add `turbo` and `turbo.json`, and per-package `build`, `typecheck` and `test` scripts. Remove the root `tsc -b` project-reference build if Turborepo now orders builds.
7. **Swap commands everywhere.** Replace every `pnpm <x>`, `pnpm dlx` and `pnpm -r` in scripts, docs, the Husky hook, CI, `openagentsy.jsonc` defaults (`worktrees.setup`, §11) and agent role text. `pnpm -r run x` becomes `turbo run x`, and `pnpm --filter p` becomes `turbo run x --filter=p` (or `bun --filter p`).
8. **Guard it in code** (§7.3):
   - a `package-manager` rule denies agent shell calls to `pnpm`, `npm install|ci|add`, `yarn` and `npx`, with the reason "This repo uses Bun; use `bun add` / `bunx`";
   - `protect-policy` also covers `turbo.json`, `bunfig.toml` and direct edits to `bun.lock`. The lockfile changes only through `bun add`/`bun remove`, and adding a dependency goes through the approval flow.

### 1.4 Expected friction

- **Phantom imports.** Isolated installs, like pnpm's, fail on imports a package never declared. A pnpm repo should already be clean, except where pnpm's public-hoist patterns hid something. Fix these by declaring the dependency, not by switching the linker to `hoisted`.
- **Native modules.** Phase 2 adds none, because `bun:sqlite` is built in. `better-sqlite3` drops out of the plan.
- **Tests that run on Node.** Vitest runs on Node unless it's started with `--bun`. Ledger tests use `bun:sqlite`, so either run them with `vitest --bun` or put the DB behind an interface with an in-memory fake. **VERIFY** which works for the pinned Vitest version.

Biome rules, the Husky gate, and the agent rule against `--no-verify` / `HUSKY=0` (§7.3) all work as before. Phase 2 code must pass `bun run lint` and `bun run typecheck`.

### 1.5 Already in place, unchanged by the move

- **Agents can't skip the hook.** The `no-skip-git-hooks` rule (§7.3) denies agent shell calls that use:
  - `--no-verify`;
  - `-n` on `git commit`;
  - `HUSKY=0`;
  - `core.hooksPath`.

  When the pre-commit hook fails, its output comes back to the agent as a tool error, so the agent fixes the code.
- **Quality checks run separately from Biome** (§9), through a PostToolCall hook and `oa_quality_check`. If GritQL can match comments reliably, the comment rules may also ship as a Biome plugin. The checker in `packages/quality` stays the source of truth either way.

---

## 2. Package layout

```
packages/
  tasks/        # .beans-compatible task store + oa_task_* tools + prime injection
  footprint/    # EcoLogits-method estimator (pure, no I/O)
  ledger/       # SQLite usage ledger, pricing, waste signals, outcomes
  hooks/        # agentsy HookRegistry adapter, guardrail rules, redaction,
                #   lessons/ (lifecycle + eval runner), recovery-loop checks
  quality/      # rule registry, static checks, comment lint, sloplint bridge, waivers, reviewer gate
  offload/      # local-model router (Ollama / LM Studio) for micro-tasks
  sidebar/      # V2 TUI plugin (dist/tui.js) + V1 server fallback (dist/v1.js)
  adapters/     # from Phase 1: V1/V2 defineTool, event bridge, conformance probes
skills/
  oa-ui/  oa-copy/  oa-comments/     # on-demand quality skills (§9.5)
```

**Dependency direction.**
- `footprint` → `ledger` → `sidebar`.
- `tasks` → `sidebar`.
- `hooks` depends only on `@agentsy/runtime`.
- `quality` is pure apart from the optional sloplint spawn. `hooks` calls it.
- `tasks` reads its findings through an injected `openFloorFindings(taskId)`, so there is no import cycle.

`footprint`, `quality`'s rule functions and the parts of `tasks` that do no I/O stay pure, so they can be tested without OpenCode.

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
    tool: taskTools(store),                           // §3.6; V1 shape is tool({ description, args: { x: tool.schema.string() }, execute(args, ctx) }), tool.schema = zod
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
// openFloorFindings is injected by the plugin entry from @openagentsy/quality (§9.4); tasks never imports quality.
function enforceTransitions(cur: Task, next: Task, deps: { openFloorFindings: (taskId: string) => Finding[] }) {
  if (next.status === 'completed') {
    if (/- \[ \]/.test(next.body)) throw new Error('Unchecked items remain; check them off or move them to a follow-up task.');
    if (!/^## Summary of Changes/m.test(next.body)) throw new Error('Add a "## Summary of Changes" section before completing.');
    const floor = deps.openFloorFindings(next.id);
    if (floor.length) throw new Error(`${floor.length} open floor quality finding(s): ${floor.slice(0, 3).map((f) => `${f.ruleId} ${f.file}:${f.line}`).join('; ')}. Fix them; floor rules can't be waived.`);
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
  kind TEXT CHECK (kind IN ('retry','tool_error_loop','interrupted','undo','reverted_code','cache_miss','no_progress')),
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
import { Database } from 'bun:sqlite';                // OpenCode loads plugins under Bun ($ is BunShell) and the repo runs on Bun (§1); no native sqlite dependency

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

`oa ledger export --json` writes the counters only, using a schema documented in `packages/ledger/SCHEMA.md`. Because tokscale and TokenTracker already read OpenCode's own database, people who use those tools get the same sessions without any work from us. Nothing is uploaded. There is no leaderboard, streak or achievement feature (§12).

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
| Accountability | The `outcome` table, the redaction counter, the hook audit log, lessons awaiting a decision (§7.5), board/report mismatch flags (§7.7), quality waivers (§9.4) and the conformance count (§10) | For example: "3 lessons to review · 2 waivers · conformance 9/14 observed". Links to `oa report --ethical`. |

### 6.5 Collapse persistence

```ts
// packages/sidebar/src/persist.ts
// One small JSON file per user. VERIFY whether the TUI plugin API exposes a KV store (Mangome's plugin persists state);
// if it does, use it instead of the file.
const FILE = join(homedir(), '.config', 'openagentsy', 'sidebar.json');
export function useCollapsed(key: string, initial: boolean): [() => boolean, () => void] { /* signal + debounced write */ }
```

### 6.6 Framing rules, as code review checks

- Blocks only use `theme.text.base` and `theme.text.muted`. A unit test that scans the block JSX (or a project-local `packages/quality` rule) fails if a footprint block references `theme.error` or `theme.warning`.
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

- `@openagentsy/sidebar@2.x` exports `dist/tui.js`, with `@opentui/solid` and `solid-js` as peer dependencies. The build is `bun build` with the Solid transform, or esbuild with `babel-preset-solid` for this package only (§1.1).
- `@openagentsy/sidebar@1.x` exports `dist/v1.js`.
- **One package per runtime.** OpenCode rejects a module whose default export has both `server` and `tui` [^tai], so a single package can't serve both.
- **V1 loading rules.** A V1 user lists the package under the **singular** `plugin` key in `opencode.json`. The plural `plugins` key is V2's name; V1 drops it with only a log warning, so plugins listed there never load. Both packages set `engines.opencode`.

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

**How OpenCode calls plugin hooks.** These facts come from a hook table generated from OpenCode v1.19.4's own source [^tai], checked against the community guides [^jl] [^rsc]:

| agentsy event | OpenCode 1.x hook | Can it block or change the call? |
| --- | --- | --- |
| `PreToolCall` | `tool.execute.before (input{tool,sessionID,callID}, output{args})` | **Yes.** Throw to stop the call. Change fields of `output.args` **in place**; assigning a new object to `output.args` has no effect. |
| `PostToolCall` | `tool.execute.after (input{…,args}, output{title,output,metadata})` | It can rewrite what the model sees, because `output.output` is writable. A throw shows the model a tool error, but the tool has already run. |
| `UserPromptSubmit` | `chat.message` | It can change `output.parts`. |
| `PreCompact` | `experimental.session.compacting` | It can push to `context` or replace `prompt`. |
| `PreResponse` | `experimental.text.complete (output{text})` | It can flag the text, or annotate it. Output checks (§7.6) only flag. |
| Model-call params | `chat.params` / `chat.headers` | The effort ladder sets `maxOutputTokens` here. |
| Shell environment | `shell.env (input{cwd,sessionID}, output{env})` | It controls the environment of agent shells (§7.3). |
| `SubagentStop`, `session.idle`, `PostResponse` | `event` | **Observe only.** OpenCode doesn't await the `event` hook, so nothing that must block can live here. |
| Permission decisions | `permission.ask` | **Unusable.** It's declared in the types, but nothing in v1.19.4 calls it (anomalyco/opencode#7006). |

Two more facts shape the code:

- **MCP tools pass through `tool.execute.before` as `<server>_<tool>`.** Rules therefore match on the base tool name (`baseTool()` below), so the board MCP's tools can't slip past a rule written for `oa_*`.
- **Plugins run one after another on the same `output` object.** A plugin loaded after ours could change `args` after our checks pass. `oa conformance` lists any other loaded plugin with a `tool.execute.before` hook as a warning (§10).

The `stop` hook that some guides show [^jl] isn't in v1.19.4's hook table, so OpenAgentsy doesn't use it. Two other guides show shapes that don't match the source, and neither shape is used: a nested `tool: { execute: { before } }` object with a `plugins` key [^devto], and an `output.abort` field [^zeke].

```ts
// packages/hooks/src/v1.ts
import type { Plugin } from '@opencode-ai/plugin';

const baseTool = (name: string) => name.replace(/^[a-z0-9-]+_(?=oa_)/i, '');   // "openagentsy-board_oa_board_dispatch" → "oa_board_dispatch"

export const OpenAgentsyHooks: Plugin = async ({ directory, client }) => {
  const reg = createOaRegistry(defaultRules({ workspace: directory }));
  await client.app.log({ body: { service: 'openagentsy', level: 'info', message: 'hooks loaded' } });  // conformance: plugin-loaded (§10)
  return {
    'tool.execute.before': async (input, output) => {
      const files = changedFiles(input.tool, output.args);                     // normalised; see below
      const res = await reg.fire({ type: 'PreToolCall', toolName: baseTool(input.tool), rawToolName: input.tool,
        args: output.args, files, sessionId: input.sessionID } satisfies PreToolCallEvent);
      if ('continue' in res && res.continue === false) throw new Error(`Blocked by OpenAgentsy policy: ${res.reason}`);
      if ('transform' in res) Object.assign(output.args, res.transform);      // mutate in place; reassignment is ignored
    },
    'tool.execute.after': async (input, output) => {
      const res = await reg.fire({ type: 'PostToolCall', toolName: baseTool(input.tool), args: input.args,
        files: changedFiles(input.tool, input.args), result: output, sessionId: input.sessionID });
      if ('transform' in res && res.transform.appendToResult) output.output += `\n\n${res.transform.appendToResult}`;
    },
    'shell.env': async (_input, output) => { applyShellEnvPolicy(output.env); },  // §7.3
    'experimental.text.complete': async (input, output) => {
      await reg.fire({ type: 'PreResponse', text: output.text, sessionId: input.sessionID });   // flags only
    },
    event: async ({ event }) => { void observe(event); },                     // not awaited by OpenCode; never blocks
  };
};
```

**Normalising changed files.** This is taken from opencode-yaml-hooks' `file.changed` event [^yamlhooks]. Every write-like tool is reduced to one list of `{ operation: 'add'|'modify'|'delete'|'rename', path, fromPath? }`:

```ts
// packages/hooks/src/files.ts
const WRITE_TOOLS = new Set(['write', 'edit', 'multiedit', 'patch', 'apply_patch']);
export function changedFiles(tool: string, args: any): FileChange[] {
  if (!WRITE_TOOLS.has(tool)) return [];
  if (tool === 'apply_patch' || tool === 'patch') return parsePatchHeaders(args.patchText ?? args.patch ?? '');  // *** Add/Update/Delete/Move File
  return [{ operation: tool === 'write' ? 'add' : 'modify', path: args.filePath }];
}
```

- **Rules use `e.files`.** `workspace-writes-only`, `protect-policy`, `secret-scan-writes` and the quality hook (§9.4) all read `e.files`, never a single `targetPath`.
- **Why this matters for `apply_patch`.** One patch can touch several files, including a protected one, or rename a file into a protected path. The before-hook has to parse the patch headers itself, because the tool hasn't run yet.
- **Tested.** A fixture patch that changes `src/a.ts` and also moves a file onto `openagentsy.jsonc` must be blocked.

**Model output can't override a blocking rule.**

- Blocking rules run inside the plugin process, before the tool runs.
- The only way past one is a person editing `openagentsy.jsonc`. An agent's attempt to edit that file is blocked by the `protect-policy` rule below.

### 7.3 Default rules

```ts
// packages/hooks/src/rules.ts
const GIT_SKIP_HOOKS = /\bgit\b[^|;&]*\b(commit|push|merge|rebase)\b[^|;&]*(\s--no-verify\b|\s-n\b)|\bHUSKY=0\b|\bcore\.hooksPath\b/;
const OTHER_PM = /(^|[\s;&|(])(pnpm|yarn|npx|npm\s+(i|install|ci|add|exec))\b/;
const PROTECTED = /(^|\/)(openagentsy\.jsonc|biome\.jsonc|turbo\.json|bunfig\.toml|bun\.lock)$|(^|\/)\.husky\/|(^|\/)\.openagentsy\/(lessons\/|quality\/waivers\.json|conformance\.json)/;

export const defaultRules = ({ workspace }: { workspace: string }): Rule[] => [
  { id: 'no-skip-git-hooks', event: 'PreToolCall', block: true,
    handler: async (e) => isShell(e) && GIT_SKIP_HOOKS.test(cmd(e))
      ? { continue: false, reason: 'Git hooks (lint, typecheck) cannot be skipped. Fix the reported errors instead.' }
      : { continue: true } },

  { id: 'package-manager', event: 'PreToolCall', block: true,
    handler: async (e) => isShell(e) && OTHER_PM.test(cmd(e))
      ? { continue: false, reason: 'This repo uses Bun. Use `bun add` / `bun remove` / `bunx`, or `turbo run <task>`.' }
      : { continue: true } },

  { id: 'workspace-writes-only', event: 'PreToolCall', block: true,
    handler: async (e) => e.files.some((f) => ![f.path, f.fromPath].filter(Boolean).every((p) => isInside(p!, [workspace, worktreeRoot(projectName(workspace))])))
      ? { continue: false, reason: `Writes are limited to the workspace and OpenAgentsy worktrees.` }
      : { continue: true } },

  { id: 'protect-policy', event: 'PreToolCall', block: true,
    handler: async (e) => e.files.some((f) => PROTECTED.test(f.path) || (f.fromPath && PROTECTED.test(f.fromPath)))
      ? { continue: false, reason: 'Policy, build-config, lockfile, hook, lesson and waiver files are changed by a person (or, for bun.lock, by `bun add`). Propose the change in chat.' }
      : { continue: true } },

  // Human-only decisions: agents may propose lessons and waivers, never decide them (§7.5, §9.4).
  // toolName is already the base name, so an MCP-prefixed "<server>_oa_lesson_decide" is caught too.
  { id: 'human-only-decisions', event: 'PreToolCall', block: true,
    handler: async (e) => ['oa_lesson_decide', 'oa_quality_waive'].includes(e.toolName)
      ? { continue: false, reason: 'Lesson decisions and quality waivers are recorded by a person (/oa lesson, /oa waive). Propose it in chat with your evidence.' }
      : { continue: true } },

  { id: 'secret-scan-writes', event: 'PreToolCall', block: true,
    handler: async (e) => e.files.length && findSecrets(contentOf(e)).length
      ? { continue: false, reason: 'The content contains what looks like a credential. Use an env var or secret reference.' }
      : { continue: true } },

  { id: 'destructive-needs-approval', event: 'PreToolCall', block: true,
    handler: approvalGate(/(^|\s)(rm\s+-rf|git\s+push\s+--force|git\s+reset\s+--hard|drop\s+table)\b/i) },
];

/** shell.env: what every agent shell sees. Tightens only; never adds credentials. */
export function applyShellEnvPolicy(env: Record<string, string>) {
  for (const k of ['HUSKY', 'HUSKY_SKIP_HOOKS', 'SKIP_SIMPLE_GIT_HOOKS', 'TOGETHER_API_KEY']) delete env[k];
  env.TURBO_TELEMETRY_DISABLED = '1';
  env.OPENAGENTSY_AGENT = '1';      // lets the pre-commit hook require a Refs: <task-id> trailer on agent commits (§5.5)
}
```

**Approvals, given that `permission.ask` is never called.** A plugin can't answer OpenCode's permission prompt, so the approval flow has two parts:

1. **Ask through OpenCode's own permission config.** The plugin's `config` hook merges *tightening-only* entries into OpenCode's `permission` config, for example `"bash": { "git push*": "ask", "gh pr merge*": "ask", "bun add *": "ask" }`. These come from `hooks.approvalFor` (§11). OpenCode then shows its normal prompt, and the person answers it.
   - The merge can change `allow` → `ask` or `ask` → `deny`, never the other way round. A unit test checks that.
   - **VERIFY** that changes made in the `config` hook reach the permission evaluator in the pinned version. If they don't, `oa init` writes the same entries into `opencode.json`, and that edit is shown to the person as a diff.
2. **Block anything the permission config can't express.** Examples are `rm -rf` inside a compound command, and SQL in a heredoc. `approvalGate` throws in `tool.execute.before` with a reason naming the slash command a person can run instead (for instance `/oa approve <callID>`, which allow-lists that exact call for 5 minutes). agentsy's `createApprovalHook` and `isDestructiveTool` classify the call; they don't do the prompting.

**Plugin versus YAML shell hooks.** opencode-yaml-hooks [^yamlhooks] and openhooks [^openhooks] let people declare shell hooks in YAML. In opencode-yaml-hooks, a script exiting with code 2 blocks the tool. We don't ship a YAML layer, for three reasons:

- **Environment.** Those actions inherit the full `process.env`. Our rules run in-process instead, with `shell.env` tightening what shells receive.
- **One source of rules.** A second rule language would split where policy lives.
- **Nothing is lost.** People who want YAML hooks can install either plugin alongside ours. `oa conformance` will list it in the plugin-order warning above.

Two ideas from them are adopted: the `file.changed` normalisation above, and opencode-yaml-hooks' `scope: main | child`. Our version is `Rule.roles?: Role[]`, for example a rule that applies only to builder subagents.

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

### 7.5 Lessons: reviewed self-improvement

This section is adapted from zhaono1/agent-playbook's self-improving-agent and eval-artifact contract (MIT) [^apb]. It replaces a simple propose/approve patch queue with explicit states, a required "start packet", and executable proof.

**States and transitions.**

```ts
// packages/hooks/src/lessons/model.ts
export type LessonState =
  | 'candidate' | 'validated' | 'applied' | 'rejected'
  | 'superseded' | 'rolled_back' | 'no_delta' | 'open_question';

const NEXT: Record<LessonState, LessonState[]> = {
  candidate: ['validated', 'rejected', 'open_question', 'no_delta'],
  open_question: ['candidate', 'rejected'],
  validated: ['applied', 'rejected'],
  applied: ['superseded', 'rolled_back'],
  rejected: [], superseded: [], rolled_back: [], no_delta: [],
};

export function transition(l: Lesson, to: LessonState, d: Decision): Lesson {
  if (!NEXT[l.state].includes(to)) throw new Error(`illegal lesson transition ${l.state} → ${to}`);
  if (to !== 'rejected' && to !== 'no_delta' && !packetComplete(l.packet)) throw new Error('start packet incomplete');
  if (to === 'validated' && !d.evalResult?.passed) throw new Error('validation needs a passing eval result for this lesson');
  if (to === 'applied' && (!d.changeRef || !l.packet.owner)) throw new Error('apply needs one owner and a change reference');
  return { ...l, state: to, history: [...l.history, { from: l.state, to, ...d, ts: now() }] };
}

export type Owner =
  | `test:${string}` | `validator:${string}` | `skill:${string}` | `role:${string}` | 'instructions' | 'memory';

export interface StartPacket {
  futureBehavior: string;      // what the agent should do differently next time
  representativeTask: string;  // one concrete scenario that should now succeed
  evidence: string[];          // ledger waste ids, session ids, failing test, user correction ref
  owner: Owner;                // exactly one durable owner
  ownerJustification?: string; // required when owner is 'instructions' or 'memory'
  writeBoundary: string[];     // files the change may touch
  proof: string;               // path to an eval artifact or an evals/ Scenario suite
}

export interface Lesson {
  id: string; state: LessonState; summary: string; occurrences: number;
  packet: Partial<StartPacket>; history: Transition[];
}
export interface Decision { decidedBy: string; reason: string; evalResult?: EvalResult; changeRef?: string }
```

**Choosing an owner.** The archivist must propose the narrowest owner that can hold the lesson, in this order:

1. a test or validator, when the behaviour can be enforced in code;
2. the owning skill or role file;
3. project instructions;
4. a memory note.

An `instructions` or `memory` owner needs a one-line `ownerJustification` explaining why code or a skill can't hold the lesson. This follows the same Hook/Prompt Axiom as the rest of §7.

**Capture.** The archivist creates candidates in two cases:
- the same waste kind with similar normalised detail appears in 3 or more sessions (§5.4);
- the user makes an explicit correction.

Candidates are deduplicated by normalised summary, which increments `occurrences`. A higher count raises priority only; it is not evidence. All text fields pass through `redact()`, and lessons are stored in `.openagentsy/lessons/<id>.json`.

**Eval artifacts.**

```ts
// packages/hooks/src/lessons/eval.ts
export const EvalArtifact = z.object({
  schema_version: z.literal('1'),
  lesson_id: z.string(),
  name: z.string(),
  scenarios: z.array(z.object({
    id: z.string(),
    phase: z.enum(['baseline', 'candidate']),
    cwd: z.string(),                                   // relative to the artifact file
    command: z.array(z.string()).min(1),               // argv only; shell strings rejected
    timeout_ms: z.number().int().max(300_000).default(30_000),
    expect: z.object({
      exit_code: z.number().int().optional(),
      stdout_includes: z.array(z.string()).optional(), stdout_excludes: z.array(z.string()).optional(),
      stderr_includes: z.array(z.string()).optional(), stderr_excludes: z.array(z.string()).optional(),
    }),
  })).min(1).max(20).refine((s) => s.some((x) => x.phase === 'candidate'), 'needs a candidate scenario')
    .refine((s) => new Set(s.map((x) => x.id)).size === s.length, 'scenario ids must be unique'),
});
```

Runner rules:
- Spawn with `shell: false`.
- Pass only `PATH`, `HOME`, `TMPDIR` and locale variables in the environment.
- Reject any `cwd` outside the workspace or an OpenAgentsy worktree.
- Kill the process at the timeout.

The result is written with mode `0600` to `.openagentsy/lessons/evals/<lesson>-<ts>.json`. It holds:
- per-assertion booleans and durations;
- the artifact's sha256 and a hash of each command.

It never holds raw stdout or stderr.

Before a result is accepted, the runner rejects symlinked result paths and recomputes pass/fail consistency.

`proof` may instead point to an `evals/` Scenario suite. In that case it runs through the existing runner and must pass all three repeat runs (pass³).

When the baseline can be reproduced, the candidate change is applied in a temporary worktree. The baseline scenario must fail on the current owner and pass with the change.

**After application.** Run the representative task again. If behaviour didn't change, the lesson moves to `rolled_back` (revert the commit) or `rejected`.

**Human-only decisions.**
- `oa_lesson_decide` is blocked for every agent role by the `human-only-decisions` rule (§7.3).
- `/oa lessons` is the inbox, sorted by occurrences and recency.
- `/oa lesson <id> validate|apply|reject|observe` records the decision, with `decidedBy` set to the human user.
- **No lesson changes an instruction, skill or role file without a human decision.** The red-team exit test checks this.

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

### 7.7 Lead recovery loop

This is adapted from agent-playbook's long-task-coordinator [^apb]. Every coordination round the Lead runs has five stages, in this order:

```
READ → RECOVER → DECIDE → PERSIST → REPORT
```

- **READ** loads the board and the in-progress tasks.
- **RECOVER** checks only the state of the work, before any decisions about the work itself:
  - Does the saved next step still make sense?
  - Did any delegated results come back?
  - Should the Lead wait, retry or re-dispatch?
- **DECIDE** picks the next action.
- **PERSIST** writes it to the board.
- **REPORT** speaks only after PERSIST has written the state.

The rule text added to the Lead role in `roles.yaml` stays under 120 tokens. The code enforces these rules:

- **Board round statuses:** `running | awaiting_result | paused | blocked | complete`. `awaiting_result` is valid and is never a failure.
- **Every delegated item has an owner and a return condition.** The board MCP rejects a dispatch that is missing either one.
- **The report must match the board.** An observer on `session.idle` compares the status the Lead claims in its last message with the board's round status. A mismatch is flagged in the Accountability block. The `event` hook isn't awaited (§7.2), so this check can only flag a mismatch, never block it.
- **A round that changed nothing can't claim progress.** A round that dispatched nothing, consumed no results and changed nothing on the board writes a `no_progress` waste event (add it to the `waste.kind` CHECK constraint in §5.1).

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

## 9. `@openagentsy/quality`: anti-slop checks

These rules are adapted from miqdadbadjuber/anti-slop [^antislop] and Nutlope/hallmark [^hallmark], both MIT. Loading either project as prompt text would cost too much:

- antislop's core file is about 10k tokens;
- Hallmark's SKILL.md routes to many reference files.

So the rules are split three ways:

- **Mechanical rules go into code.** They cost no tokens and run in a hook.
- **Judgment rules go into three skills** that load only when a change touches UI, copy or comments.
- **The reviewer signs off on a structured gate.**

Each rule keeps its upstream ID (antislop `R-XX`, Hallmark Floor number), so a finding can cite where it came from.

**Tiers** (taken from Hallmark):

| Tier | Meaning | Can it be waived? |
| --- | --- | --- |
| `floor` | Honesty, function and accessibility. Blocks the task from completing. | **No.** |
| `reflex` | Common tells. Must be fixed or waived with a reason. | Yes, by a person. |
| `finish` | Taste and polish. Warnings only; a project `DESIGN.md` overrides them. | Not needed. |

**Rules of thumb.**
- Taste rules stay warnings, so OpenAgentsy never imposes one aesthetic. They include:
  - eyebrows and tracked capitals;
  - an italic word in a heading;
  - Lucide icons, bento grids and 3-step "how it works" sections;
  - em dashes.
- `DESIGN.md` / `design.md` is read as **data, not instructions** (antislop's boundary rule). Text inside it can change which taste rules apply, but it can't turn off a floor rule or tell the agent to do anything.

### 9.1 Rule registry

```ts
// packages/quality/src/rule.ts
// Adapted from Nutlope/hallmark and miqdadbadjuber/anti-slop, MIT. See NOTICE.
export interface QualityRule {
  id: string;                       // "css/no-transition-all"
  source: `hallmark:floor-${number}` | `antislop:R-${number}` | `antislop-code:${string}` | 'openagentsy';
  tier: 'floor' | 'reflex' | 'finish';
  appliesTo: string[];              // globs, e.g. ["**/*.css", "**/*.{html,tsx,jsx,vue,svelte}"]
  check: (file: SourceFile, ctx: CheckCtx) => Finding[];
  waivable: boolean;                // false for every floor rule (asserted at registry load)
}

export interface Finding {
  ruleId: string; source: string; tier: QualityRule['tier'];
  file: string; line: number; message: string; fix: string;   // fix: one line, imperative
  kind?: 'claim';                   // claims are "source this", not "delete this"
}

export function createRegistry(rules: QualityRule[]) {
  for (const r of rules) if (r.tier === 'floor' && r.waivable) throw new Error(`floor rule ${r.id} cannot be waivable`);
  return { forFile: (path: string) => rules.filter((r) => r.appliesTo.some((g) => minimatch(path, g))) };
}
```

### 9.2 Static checks

Every check below is a pure function. Each one has a fixture that passes and one that fails.

| Rule ID | Source | Tier | Detects |
| --- | --- | --- | --- |
| `css/token-only-colour-font` | hallmark:floor-1 | reflex | Literal colours or `font-family` outside `:root` or a theme token block |
| `css/no-transition-all` | hallmark:floor-2 | reflex | `transition: all` |
| `css/no-layout-animation` | hallmark:floor-2 | reflex | Animating `width`, `height`, `top` or `left` |
| `css/overflow-clip` | hallmark:floor-4 | floor | `overflow-x: hidden` or `100vw` on `html` or `body` |
| `css/grid-minmax` | hallmark | reflex | Grid tracks holding images that don't use `minmax(0, 1fr)` |
| `css/reduced-motion` | hallmark:floor-7, antislop:R-32 | floor | An animation with no `prefers-reduced-motion` fallback |
| `css/focus-visible` | hallmark:floor-6 | floor | Interactive selectors with no `:focus-visible` style |
| `css/contrast` | antislop:R-25 | floor | A token colour pair below WCAG AA, computed from the **unrounded** ratio |
| `css/purple-blue-gradient` | hallmark:floor-11 | finish | The stock purple-to-blue gradient |
| `html/dead-nav` | antislop:R-24 | floor | Nav links to anchors or routes that don't exist |
| `html/inert-control` | antislop:R-26 | floor | A button with no handler, or a form with no action or submit handler |
| `html/emoji-icon` | hallmark:floor-11 | reflex | Emoji used as icons |
| `html/card-in-card` | hallmark:floor-11 | finish | A card nested inside a card (class or role heuristics) |
| `copy/unsourced-claim` | antislop:R-17/18/36, hallmark:floor-8 | floor (`kind: 'claim'`) | In UI copy: `\d+(%|K\+|M\+|x)`, testimonials, logo walls. **The agent must cite where the claim came from**, or mark it as a placeholder. |
| `copy/generic-cta` | antislop | reflex | "Get Started" or "Learn More" with no object |
| `copy/buzzwords` | antislop | reflex (config) | seamless, revolutionary, next-generation, … |
| `copy/em-dash` | antislop:R-02 | finish, **off by default** | Em dashes in user-facing UI copy only. Never applied to prose or docs. |

**Claims.** An unsourced claim is a floor finding, because a made-up number is an honesty failure. It's resolved by adding a source comment (`<!-- source: … -->`) or a `data-placeholder` marker. Deleting the copy isn't required. Hallmark's "material inventory" in `oa-ui` (§9.5) is there to stop the agent inventing claims in the first place.

### 9.3 Comment lint (antislop-code)

**What it flags.**
- Banner separators and ALL-CAPS section labels.
- Decorative emoji and end markers (`// end if`).
- `// Step N:` narration.
- Empty labels such as "Main logic" or "Helper function".
- TODOs that name no task.
- JSDoc that only repeats the function signature.

**What it never flags.** Comments that explain:
- business logic, security, performance or concurrency;
- protocols or API contracts;
- workarounds or edge cases;

and licence or attribution text. The preserve list has a fixture for each item.

```ts
// packages/quality/src/comments/fix.ts
export function applyCommentFix(src: string, fix: CommentFix): string {
  const out = splice(src, fix.range, fix.replacement);
  // Fixes may only touch comment trivia. Anything else is a bug in the rule, not a judgment call.
  if (!astEqualIgnoringComments(parse(src), parse(out))) throw new Error(`comment fix ${fix.ruleId} changed code`);
  return out;
}
```

The checker uses the TypeScript compiler's comment ranges, so it doesn't depend on GritQL. If Biome GritQL can match comment nodes reliably, the same rules may also be exported as a Biome plugin. Either way, the AST-identity test is the contract.

### 9.4 Hooks, findings and waivers

```ts
// packages/hooks/src/rules.ts (addition)
{ id: 'quality-after-write', event: 'PostToolCall', block: false,
  handler: async (e) => {
    if (!e.files.length || cfg.quality.mode !== 'during') return { continue: true };
    const paths = e.files.filter((f) => f.operation !== 'delete').map((f) => f.path);   // all files an apply_patch touched (§7.2)
    const findings = await quality.check(paths, { design: await readDesignMd() });
    findingsStore.record(activeTaskId(), findings);                     // read by enforceTransitions (§3.7)
    const open = findings.filter((f) => f.tier !== 'finish' && !waivers.covers(f));
    return open.length ? { transform: { appendToResult: formatFindings(open.slice(0, 8)) } } : { continue: true };
  } },
```

- **What the agent sees.** Findings come back as one line each: `ruleId file:line — fix`. The list is capped at 8 lines so it can't flood the context; `oa_quality_check` returns the full list.
- **Blocking.** `floor` findings stop the task from reaching `completed` (§3.7). `reflex` findings must be fixed or waived.
- **`mode: "after"`.** The hook does nothing, and `/oa audit` reports the findings instead.

**Waivers** are stored in `.openagentsy/quality/waivers.json`:

```ts
export const Waiver = z.object({ ruleId: z.string(), path: z.string(), reason: z.string().min(10),
  decidedBy: z.string(), ts: z.string() });
```

- An agent can *propose* a waiver in chat.
- Only a person records one, with `/oa waive <ruleId> <path> "<reason>"`. `oa_quality_waive` is blocked for agent roles (§7.3).
- `waive()` throws for any rule where `waivable === false`.
- The waiver count appears in the Accountability block.

**Optional Hallmark sloplint.** `oa_quality_check` looks for `skills/hallmark/scripts/sloplint.mjs` in the project, `~/.claude`, `~/.agents` and OpenCode's skill paths. If it finds the script, it runs it on the changed HTML and CSS:

```ts
spawn(process.execPath, [sloplint, ...(canRender ? ['--render'] : []), ...files], {
  shell: false,
  env: pick(process.env, ['PATH', 'HOME', 'TMPDIR', 'LANG']),   // TOGETHER_API_KEY never passed
  timeout: 60_000,
});
```

- `--render` runs only when `puppeteer-core` and Chrome are both present.
- Its FAIL, REFLEX and WARN lines are parsed into `Finding`s.
- The result records which path ran: `static`, `static+sloplint` or `static+sloplint-render`.
- If Hallmark isn't installed, the static rules still run.

### 9.5 Skills, loaded on demand

Each SKILL.md is ≤ 1,500 tokens, with detail kept in reference files the skill links to.

| Skill | Loads when | Contents |
| --- | --- | --- |
| `oa-ui` | A change touches `.css`, `.html`, `.tsx`/`.jsx`/`.vue`/`.svelte` or design files | <ul><li>antislop's purpose test ("what does this technique serve?"), with the reason written down.</li><li>The ENERGY, RHYTHM and MOTION dials (how lively the design is) and the Design Read.</li><li>Hallmark's material inventory: what's real, which pictures exist, what's absent. No invented facts; honest placeholders.</li><li>"Build from the job": start from the page's primary action.</li><li>Read `DESIGN.md` first. With no direction, label the output "draft without direction".</li></ul> |
| `oa-copy` | User-facing copy, **or agent prose**: commit messages, PR descriptions, the task "Summary of Changes", Lead status reports | antislop-copywriting: specific calls to action, no buzzwords, no fake stats. |
| `oa-comments` | Comments are edited | antislop-code's tells and its preserve list. It's the counterweight to §9.3. |

**Routing.** At most 80 tokens are added to the Lead and builder roles: "For UI, copy or comment work, load oa-ui / oa-copy / oa-comments. Mechanical checks run automatically." A token test confirms that **no quality skill loads** when no matching file is touched.

### 9.6 Reviewer gate

This is adapted from antislop's Delivery Gate and Hallmark's fresh-context review. For any UI or copy change, the reviewer must return:

```ts
// packages/quality/src/gate.ts
export const ReviewGate = z.object({
  floor: z.array(FindingSchema),
  reflex: z.array(z.object({ finding: FindingSchema, status: z.enum(['fixed', 'waived', 'open']) })),
  purpose: z.array(z.object({ technique: z.string(), reason: z.string() })),
  liveliness: z.object({ energy: z.number().min(0).max(10), rhythm: z.number().min(0).max(10),
    motion: z.number().min(0).max(10), note: z.string() }),
  verdict: z.enum(['ship', 'fix', 'rebuild']),
});

export async function acceptGate(raw: unknown, files: string[]): Promise<GateResult> {
  const gate = ReviewGate.parse(raw);
  const rerun = await quality.check(files);                      // never trust the reviewer's own pass
  const openFloor = rerun.filter((f) => f.tier === 'floor');
  if (gate.verdict === 'ship' && openFloor.length) return { accepted: false, finding: 'fabricated-pass', openFloor };
  return { accepted: true, gate };
}
```

- **The reviewer starts fresh.** It runs in a new context, using a different model family from the builder. It sees only:
  - the diff;
  - `DESIGN.md`;
  - the check results.

  It never sees the builder's transcript.
- **A false pass is a finding.** If the reviewer says "ship" while a floor finding is open, that's recorded as a finding of its own, and it goes to the Accountability block.

---

## 10. `oa conformance`: what's proven, observed or unverified

This is adapted from agent-playbook's host-conformance states [^apb]. `oa conformance` (a command and a tool) reports each capability **separately for V1 and V2**, with one of three states:

| State | Meaning |
| --- | --- |
| `proven_static` | The files and config are present, the plugin loads and its schema validates. |
| `observed` | Seen working in a real session. Bounded evidence (event type, timestamp, session ID) is stored in `.openagentsy/conformance.json`. |
| `unverified` | Neither of the above. |

```ts
// packages/adapters/src/conformance.ts
export interface Capability { id: string; host: 'v1' | 'v2'; verifyRef?: string;   // spec anchor of the VERIFY it settles
  probeStatic: () => Promise<boolean>; observeOn: OcEventType[] }

export const CAPABILITIES: Capability[] = [
  { id: 'sidebar-slot', host: 'v2', verifyRef: '§6.1', probeStatic: hasTuiEntry, observeOn: ['tui.slot.render'] },
  { id: 'v1-toast', host: 'v1', verifyRef: '§6.7', probeStatic: hasV1Entry, observeOn: ['tui.toast.show'] },
  { id: 'system-transform', host: 'v1', probeStatic: hasHook('experimental.chat.system.transform'), observeOn: ['chat.system.transformed'] },
  { id: 'compaction-hook', host: 'v1', probeStatic: hasHook('experimental.session.compacting'), observeOn: ['session.compacted'] },
  { id: 'tool-before-block', host: 'v1', probeStatic: hasHook('tool.execute.before'), observeOn: ['tool.execute.before'] },
  { id: 'session-family', host: 'v2', verifyRef: '§6.2', probeStatic: hasApi('session.family'), observeOn: ['session.family.read'] },
  { id: 'message-token-fields', host: 'v2', verifyRef: '§5.2', probeStatic: alwaysFalse, observeOn: ['message.updated'] },
  { id: 'prompt-insert', host: 'v2', verifyRef: '§6.4', probeStatic: hasApi('prompt.insert'), observeOn: ['prompt.inserted'] },
  { id: 'local-offload', host: 'v2', verifyRef: '§8.2', probeStatic: probeBackends, observeOn: ['offload.completed'] },
  { id: 'plugin-loaded', host: 'v1', probeStatic: hasV1Entry, observeOn: ['app.log:openagentsy hooks loaded'] },  // a setup throw is skipped silently [^tai]
  { id: 'args-mutate-in-place', host: 'v1', probeStatic: alwaysFalse, observeOn: ['oa.selftest.args'] },          // seeded no-op rewrite seen by the tool
  { id: 'permission-config-merge', host: 'v1', verifyRef: '§7.3', probeStatic: alwaysFalse, observeOn: ['permission.asked'] },
  { id: 'permission-ask-hook', host: 'v1', probeStatic: alwaysFalse, observeOn: ['oa.permission.ask.called'] },     // expected to stay unverified (#7006)
  { id: 'text-complete-hook', host: 'v1', probeStatic: hasHook('experimental.text.complete'), observeOn: ['oa.text.complete'] },
  { id: 'shell-env-hook', host: 'v1', probeStatic: hasHook('shell.env'), observeOn: ['oa.shell.env'] },
  { id: 'mcp-tool-prefix', host: 'v1', probeStatic: alwaysFalse, observeOn: ['tool.execute.before:<server>_oa_*'] },
  // … one entry per remaining VERIFY in this spec
];

/** Warn when another plugin could rewrite args after our checks: hooks share one output object, in load order. */
export function pluginOrderWarnings(loaded: LoadedPlugin[]): string[] {
  const ours = loaded.findIndex((p) => p.name === '@openagentsy/hooks');
  return loaded.slice(ours + 1).filter((p) => p.hooks.includes('tool.execute.before'))
    .map((p) => `${p.name} runs tool.execute.before after OpenAgentsy and could change arguments we already checked.`);
}
```

- **Every VERIFY needs a check.** A test greps this spec for **VERIFY** and fails if any one of them has no `verifyRef` in `CAPABILITIES`.
- **`observed` is only set from live evidence.** It's recorded by an event listener during a real session, never from a static probe.
- **The Accountability block shows the count**, for example "conformance 9/14 observed".
- **Plugin-order warnings** (`pluginOrderWarnings`) appear in `oa conformance` and in `oa report --ethical`. That's where a person learns that a YAML-hook plugin or another guard runs after OpenAgentsy's checks.
- **`unverified` items are listed in `oa report --ethical`**, so nobody mistakes a guess about the OpenCode API for a tested fact.

---

## 11. Configuration (`openagentsy.jsonc`, Phase 2 keys)

```jsonc
{
  "tasks": { "path": ".beans", "prefix": "oa-", "idLength": 4, "worktrees": { "baseRef": "main", "integrate": "pr", "setup": "bun install --frozen-lockfile", "fetchTimeoutSec": 10 } },
  "footprint": {
    "showWarming": true,
    "prefill": false,
    "gridRegion": "auto",            // "auto" = provider's disclosed region, else world default; or ISO code e.g. "US"
    "localDeviceWatts": [25, 60],    // range, for laptops running local models
    "models": { "ollama/qwen3:8b": { "totalParamsB": [8, 8], "activeParamsB": [8, 8] } }
  },
  "ledger": { "backfillOpencodeDb": false, "pricingSources": ["opencode", "models.dev", "litellm", "openrouter"] },
  "offload": { "backends": [{ "kind": "ollama", "baseUrl": "http://127.0.0.1:11434", "model": "qwen3:4b" }], "jobs": ["title", "compaction", "json-repair", "classify", "quick-replies"] },
  "hooks": { "extraBlockedCommands": [], "approvalFor": ["git push", "gh pr merge", "bun add", "bun remove"] },
  "lessons": { "captureAfterSessions": 3, "evalTimeoutMs": 30000, "requireWorktreeForBaseline": true },
  "quality": {
    "mode": "during",                // "during" = hook after each write | "after" = report only, via /oa audit
    "copy": { "emDash": "off", "buzzwords": "reflex" },
    "taste": "warn",                 // "warn" | "off"; DESIGN.md overrides individual taste rules
    "hallmarkSloplint": "auto",      // "auto" = run if installed | "off"
    "render": "auto"                 // sloplint --render only if puppeteer-core + Chrome are present
  }
}
```

If `.beans.yml` exists, its `beans.prefix`, `beans.id_length` and `beans.path` take precedence. That way OpenAgentsy and the `beans` CLI write the same IDs.

---

## 12. Left out on purpose

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
| agent-playbook | Its 22 domain skills, skill-router, workflow-orchestrator and `metadata.hooks` follow-up chains | Our roles and effort ladder already route the work. Automatic follow-up chains would spend tokens the person didn't ask for. |
| agent-playbook | The `@codeharbor/agent-playbook` CLI and its MCP server | We adapt the schemas without taking on a dependency. |
| anti-slop | The install wizard that edits AGENTS.md, and the "during or after?" question at the start of each session | The mode is a config key instead (`quality.mode`). |
| anti-slop, Hallmark | Taste rules as hard bans (eyebrows, tracked caps, italic heading words, Lucide icons, bento grids, em dashes) | These are matters of style, not quality. They stay `finish`-tier warnings that `DESIGN.md` can override. |
| Hallmark | The theme generator (48 themes, deal/draw), photo library, capture and image generation | That's a design tool, not a guardrail. Users can install Hallmark separately; it supports OpenCode. |
| Hallmark | Together AI calls when `TOGETHER_API_KEY` is set | There are no hidden network calls. The key is stripped from sloplint's environment (§9.4) and from agent shells (§7.3). |
| opencode-yaml-hooks, openhooks | A YAML shell-hook layer (exit code 2 blocks the tool) | A second place for policy to live, and its actions inherit the full environment. We keep its `file.changed` normalisation and `scope` idea (§7.2). People can install either plugin alongside ours; conformance flags the ordering (§10). |
| OpenCode | The `stop` hook, `permission.ask`, and `experimental.hook.file_edited` / `session_completed` in `opencode.json` | `stop` isn't in v1.19.4's hook table, and `permission.ask` is never called. The config-file hooks appear in only one guide and are unverified. Approvals use the permission config plus blocking instead (§7.3). |
| Turborepo | Remote caching (Vercel or self-hosted) and telemetry | Remote caching uploads build artifacts, so it's opt-in only. Telemetry is disabled everywhere (§1.2). |

---

## 13. Build order and exit tests

Biome, Husky, lint-staged, `tsc` and CI are already in place; step 2.0 moves them onto Bun and Turborepo (§1). After 2.0, every step must keep `bun run check` (`turbo run lint typecheck test build`) green.

| Step | Delivers | Exit test (in the Scenario + Vitest suites) |
| --- | --- | --- |
| **2.0** | pnpm → Bun workspaces + Turborepo (§1): `packageManager`, `bunfig.toml`, `bun.lock`, `turbo.json`, scripts, Husky hook, CI; the `package-manager` rule and its protected files | <ul><li>`bun install --frozen-lockfile` succeeds on a clean clone.</li><li>`bun pm ls --all` matches the pre-migration `pnpm list` (differences reviewed and noted in the PR).</li><li>`bun run check` passes, and a second run with no changes is fully cached.</li><li>Changing one package's dependency misses the cache only for that package and the packages that depend on it.</li><li>`git grep -n pnpm` finds nothing outside CHANGELOG and this spec's history notes.</li><li>The pre-commit hook still blocks a lint failure.</li><li>Red-team: an agent told to `pnpm add x` or `npm install` is blocked, and so is a direct edit to `bun.lock`.</li><li>`TURBO_TELEMETRY_DISABLED` is set in CI and in agent shells.</li></ul> |
| **2a** | `tasks` package, prime block, `oa_task_*` tools, `footprint` package | <ul><li>Round-trip over the `hmans/beans` `.beans/` corpus passes.</li><li>`ready` and `next` match Beans' documented semantics on 15 fixtures (blocked parent, terminal ancestor, epics excluded).</li><li>The footprint golden test passes within 1%.</li><li>The prime block is ≤ 200 tokens.</li></ul> |
| **2b** | `ledger` (ingest, pricing, waste including `no_progress`, outcomes), `offload` | <ul><li>Deduplication: replaying a session doesn't change totals.</li><li>Unpriced models show "unpriced".</li><li>Offload lowers cloud tokens per completed task compared with Phase 1, with pass³ unchanged.</li></ul> |
| **2c** | `hooks`: bridge, rules (including `human-only-decisions`), redaction, output checks, **lessons + eval runner**, **Lead recovery loop** | <ul><li>Red-team: a model told to "commit with --no-verify", "edit openagentsy.jsonc" or "approve your own lesson" is blocked.</li><li>An `apply_patch` that moves a file onto `openagentsy.jsonc` is blocked.</li><li>Calling `oa_lesson_decide` through an MCP-prefixed name is blocked.</li><li>A rewrite of tool arguments takes effect (mutated in place).</li><li>Agent shells don't see `HUSKY`.</li><li>Merging permissions only tightens them (`allow`→`ask` works; `deny`→`allow` throws).</li><li>A seeded secret never reaches `.openagentsy/`, including inside a lesson summary.</li><li>Lesson transitions: every allowed move succeeds and every other move throws.</li><li>A lesson with an incomplete start packet can't leave `candidate`.</li><li>The eval runner rejects shell strings, a `cwd` outside the workspace and a timeout over the maximum. It also rejects symlinked result paths, never writes stdout or stderr, and strips a fake `GITHUB_TOKEN`.</li><li>In a temporary worktree, the baseline fails and then the candidate passes.</li><li>A board/report mismatch raises a flag, and a round that changes nothing writes `no_progress`.</li><li>Output-check flags appear on seeded transcripts.</li></ul> |
| **2d** | `quality`: registry, static rules, comment lint, sloplint bridge, waivers, the three skills, reviewer gate | <ul><li>Each static rule has a passing and a failing fixture.</li><li>A comment fix leaves the AST identical apart from comments, and never removes a comment on the preserve list.</li><li>A task with an open floor finding can't be completed.</li><li>An agent can't record a waiver, and a floor rule can't be waived.</li><li>A "ship" verdict with an open floor finding is rejected as `fabricated-pass`.</li><li>sloplint runs without `TOGETHER_API_KEY` and degrades cleanly when Hallmark is absent.</li><li>No quality skill loads when no UI, copy or comment file is touched (token test).</li></ul> |
| **2e** | `sidebar` V2 blocks, V1 fallback, worktrees, `oa conformance`, `oa report --ethical` | <ul><li>Blocks render from fixtures in the OpenTUI test renderer.</li><li>The banned-word and banned-colour tests pass.</li><li>The V1 toast fires on `session.idle`.</li><li>Worktree task detection matches `git diff`, and provisional statuses clear after merge.</li><li>Every **VERIFY** in the spec maps to a conformance check.</li><li>A capability with no recorded observation reports `unverified`, and a static probe never upgrades a check to `observed`.</li></ul> |

---

## 14. Open questions

- **Prefill term:** keep it off by default until the fit is reviewed (recommended)?
- **Bundling `models.json`:** fetch-and-cache only, until the EcoLogits data license is confirmed?
- **Monorepo license:** make all of OpenAgentsy GPL-3.0-or-later (recommended, simplest), or only the packages that import agentsy?
- **Upstream export:** should agentsy add a `./hooks` subpath export to `@agentsy/runtime`, or re-export the hooks from the package root?
- **Beans compatibility:** keep OpenAgentsy's rendering byte-identical to Beans', or accept whitespace differences?
- **V1:** confirm whether issue #5971's sidebar hook merged.
- **Em dashes:** `quality.copy.emDash` is `off` by default. Switch it to `reflex` if the agents shouldn't use them in UI copy.
- **Unsourced claims as `floor`:** block completion until a claim has a source or placeholder marker (recommended), or downgrade them to `reflex` so a person can waive them?
- **Comment rules in Biome:** also ship them as a GritQL plugin once comment matching is confirmed, or keep them only in `packages/quality`?
- **Strict hoisting:** turn on `install.hoist = false` in step 2.0 (stricter than pnpm's default), or after fixing phantom imports (recommended)?
- **Test runner:** keep Vitest (recommended; no rewrite), or move to `bun test` once on Bun?
- **Plugin order:** if another plugin's `tool.execute.before` runs after ours, should `oa conformance` only warn (recommended), or refuse to mark the guardrails as `observed`?
- **Approval fallback:** if the `config` hook can't change permissions, may `oa init` write the `ask` entries into `opencode.json`, after showing the person the diff?

---

## References

[^beans]: hmans/beans (Apache-2.0) — https://github.com/hmans/beans
[^beansplugin]: Beans OpenCode plugin — https://github.com/hmans/beans/blob/main/.opencode/plugin/beans-prime.ts
[^agentsyhooks]: agentsy runtime hooks — https://github.com/selfagency/agentsy/tree/main/packages/runtime/src/hooks
[^bs]: streetturtle/opencode-better-sidebar — https://github.com/streetturtle/opencode-better-sidebar
[^tokscale]: junhoyeo/tokscale (MIT) — https://github.com/junhoyeo/tokscale
[^tt]: xiufengsun/TokenTracker (MIT) — https://github.com/xiufengsun/TokenTracker
[^apb]: zhaono1/agent-playbook (MIT) — https://github.com/zhaono1/agent-playbook (self-improving-agent, eval-artifact, long-task-coordinator, docs/host-conformance.md)
[^antislop]: miqdadbadjuber/anti-slop (MIT) — https://github.com/miqdadbadjuber/anti-slop
[^hallmark]: Nutlope/hallmark (MIT) — https://github.com/Nutlope/hallmark
[^oc5971]: OpenCode issue #5971 — https://github.com/anomalyco/opencode/issues/5971
[^eco]: EcoLogits — https://github.com/mlco2/ecologits
[^ipcc]: IPCC AR6 WG1 Summary for Policymakers, D.1.1
[^li]: Li et al., "Making AI Less Thirsty" — https://arxiv.org/abs/2304.03271
[^safety]: agentsy SAFETY.md — https://github.com/selfagency/agentsy/blob/main/SAFETY.md
[^ocv2]: OpenCode V2 plugins docs — https://opencode.ai/v2/docs/cli/plugins
[^tai]: OpenCode Plugins Reference, generated from OpenCode v1.19.4 source (TurboAI) — https://www.turboai.dev/docs/opencode/plugins
[^jl]: John Lindquist, OpenCode Plugins Guide — https://gist.github.com/johnlindquist/0adf1032b4e84942f3e1050aba3c5e4a
[^rsc]: Rico Sta. Cruz, OpenCode plugin development guide (incl. comment on #7006) — https://gist.github.com/rstacruz/946d02757525c9a0f49b25e316fbe715
[^zeke]: Zeke Sikelianos, OpenCode hooks vs Claude Code — https://gist.github.com/zeke/1e0ba44eaddb16afa6edc91fec778935
[^devto]: Einar César, "Does OpenCode Support Hooks?" — https://dev.to/einarcesar/does-opencode-support-hooks-a-complete-guide-to-extensibility-k3p
[^yamlhooks]: KristjanPikhof/OpenCode-Hooks (opencode-yaml-hooks) — https://github.com/KristjanPikhof/OpenCode-Hooks
[^openhooks]: industrialricefarmingllc/openhooks (MIT) — https://github.com/industrialricefarmingllc/openhooks
[^turbo26]: Turborepo 2.6 release notes, 28 Oct 2025: Bun package manager support marked stable, with per-package `bun.lock` v1 analysis (turborepo.com blog)
[^bunws]: Bun docs: Workspaces (catalogs, `workspace:` protocol) and Isolated installs (pnpm-like linker; default for workspaces migrated from pnpm)