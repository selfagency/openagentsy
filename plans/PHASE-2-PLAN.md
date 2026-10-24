# OpenAgentsy Phase 2: Implementation Plan (revision 2)

> **Revision 3 is available.** A delta document at [`PHASE-2-PLAN-REVISION3.md`](./PHASE-2-PLAN-REVISION3.md) extends this plan with eight new sections (§17 Ethics framework, §18 Safety benchmark suite, §19 Incident response, §20 Privacy and bounded personalization, §21 Policy module library, §22 Scope declarations, §23 Credential broker, §24 Sandbox for untrusted code) and extensions to §3, §4, §6, §8, §9, §10, §11, §13, §14, §15, §16. The delta is grounded in `selfagency/agentsy`'s `ETHICS.md`, `SAFETY.md`, `GOVERNANCE.md` and the creative patterns from agentsy's packages (orchestrator task-board, runtime hooks, session recovery, cognitive memory / learning loop, secrets broker, tokenomics, retrieval, gateway). Revision notes R-17..R-32 in the delta document map every change to its source. To apply revision 3: insert §17–§24 after §16, apply the section extensions in place, update §15's build order with step 2f, and update §16's open questions 15–28. Until revision 3 is applied, this revision-2 document remains the authoritative spec.

**Position.** This revision assumes the Phase 1 remediation has **landed in full**: all 38 findings of the Phase 1 code review are fixed through its 20-step plan, the safety suite runs 14 cases, and `develop` is the baseline described under "Baseline" below. It also folds in every correction from the plan review (P-01..P-16): the MCP hook fact is stated as measured, the Magic Context dependency is replaced by a memory slice we actually build, compaction is on by default, the protected-files list covers the real trust boundary, and worktrees share the board instead of forking it.

**Bottom line.** Phase 2 ships eight packages and two cross-cutting features:

- **`@openagentsy/tasks`.** A built-in task tracker that reads and writes the Beans `.beans/` Markdown format directly. It needs neither `beans-mcp` nor the `beans` CLI.
- **`@openagentsy/memory`.** The minimal memory slice: an inbox over the archivist's `bean: memory` board records (landed in the remediation), an approved-memory store, and a search tool. This replaces the previous revision's dependency on Magic Context, which no package builds.
- **`@openagentsy/footprint`.** Energy, water, carbon and warming estimates using the EcoLogits method. Every number carries a range.
- **`@openagentsy/ledger`.** A local SQLite ledger of tokens and cost per message. It also records waste signals and outcomes: tokens per completed task and per commit.
- **`@openagentsy/hooks`.** Deterministic guardrails built on agentsy's `HookRegistry`, plus secret redaction; a **lesson lifecycle** with executable eval artifacts (§8.5); and the **Lead recovery loop** (§8.7).
- **`@openagentsy/offload`.** Routes small housekeeping jobs (titles, summaries, JSON repair, quick replies) to a local model.
- **`@openagentsy/sidebar`.** The OpenCode V2 TUI sidebar blocks, with a toast and slash-command fallback for V1.
- **`@openagentsy/quality`.** The anti-slop checks: static CSS, HTML, copy and comment checks in code; optional Hallmark `sloplint`; recorded waivers; three on-demand skills; a reviewer gate (§10).
- **`oa conformance`.** Reports, per host version, which OpenCode capabilities are proven, observed or unverified (§11).
- **`oa report --ethical`.** The one-screen account of what a run cost and what it was worth (§12) — specified in this revision; previously referenced three times and never defined.

Step 2.0 (pnpm → Bun workspaces + Turborepo) and the GPL-3.0-or-later license **are already landed**; §1 records the state and the small residue that remains.

Code below is TypeScript in the style of the Phase 1 codebase. Where an OpenCode API detail is inferred rather than read from source, it's marked **VERIFY**; every **VERIFY** maps to one conformance check (§11). Facts the repo has already measured are marked **[measured]**. One rule applies throughout: **a security property never rests on an unverified fact** — where a measurement and the generated docs disagree, the design follows the measurement (§8.2).

---

## Revision notes

What changed from revision 1 and why. Sources: the Phase 1 code review (findings F-01..F-38) and the plan review (P-01..P-16).

| Change | Where | Source |
| --- | --- | --- |
| §0 and step 2.0 marked **landed** (license and toolchain landed in `eb3a7f1`); remaining work re-scoped as step 2.0r | §0, §1 | P-10 / R-1 |
| `tool.execute.before` for MCP calls stated as **[measured] not firing** on the pinned binary; `human-only-decisions` moved to the permission map as primary enforcement, hook as defense-in-depth; exit test proves both directions | §8.2, §8.3, §15 (2c) | P-01 / R-2 |
| Magic Context references removed; a minimal **memory package** is specified and built in 2a (inbox over landed `bean: memory` records → `memory.jsonl` → search) | §4, §7.4, §9.1 | P-02 / R-3 |
| Compaction hooks and the offload compaction job now rest on the remediated default (compaction **on**; `--magic-context` opt-in) | §3.5, §9.1 | P-03 / R-4 |
| `PROTECTED` extended to `roles.yaml`, `opencode.json{,c}`, `.opencode/`, `.github/workflows/`, `templates/`, `openagentsy.models.lock.json`; doctor gains a regeneration-diff check | §8.3, §15 (2c) | P-04 / R-5 |
| Worktree shared-state resolution specified: all `.openagentsy/` state resolves to the main repo root; `.beans/` stays worktree-local; 2e exit test denies a worktree builder by the Lead's main-board lease | §3.9, §15 (2e) | P-05 / R-6 |
| `defineTool` is an explicit 2a deliverable in `@openagentsy/adapter-opencode`; **no package rename**; the phantom `@openagentsy/adapters` import is gone | §2, §3.6, §15 (2a) | P-06 / R-7 |
| engines matrix fixed: root `bun`; `engines.opencode` only on host-loaded plugin packages, per major; libraries carry none | §1.4 | P-07 / R-8 |
| Budgets reconciled: caps in the board, **usage measured by the ledger**; self-reported `recordUsage` deprecated in 2b, removed in 2c | §6.7 | P-08 / R-9 |
| Config map table: five authorities, one precedence order, doctor reports all | §13 | P-09 / R-10 |
| Concurrency preconditions noted as landed (rungs session-scoped, re-grants surface `alreadyHeld`) | Baseline 7, §8.2 | P-11 |
| Naming decided once: `oa` alias bin; `board_*` keeps its prefix (compat), new tools `oa_<domain>_*`; base-name resolution by vocabulary match, not an `oa_`-specific regex; real tool names in examples | §2.2, §8.2 | P-12, P-13 / R-12 |
| Prime injection cached with a performance budget (p95 ≤ 5 ms at 500 tasks) | §3.5, §15 (2a) | P-14 / R-13 |
| Underspecified mechanisms specified: `oa report --ethical` (§12); `/oa approve` storage and TTL; `cache_miss` and `reverted_code` triggers; `-n` regex anchored; `TYPESAFE_API_KEY` stripped; `context.keymap.layer` VERIFY'd | §8.3, §6.4, §7.4, §12 | P-15 / R-14 |
| Doc sweep folded into every build step's definition of done (AGENTS.md package enumeration, plan references) | §15 | P-16 / R-15 |
| The four blind-spot eval cases noted as the landed baseline the suite extends from | Baseline 14 | R-16 |
| Ordering fix: the agent red-team for `pnpm add` moved from step 2.0 to 2c (the rule that blocks it ships in 2c) | §15 | — |

---

## Baseline: what Phase 2 builds on

The Phase 1 remediation landed the following. Phase 2 features cite them here rather than re-fix them.

1. **Role resolution.** `roleKeyForAgent` resolves `agentName` overrides (the Lead is `agentsy` in the selector and `lead` in the roles file). Every role-keyed consumer — lock lookups, rungs, triggers, harvest gating — resolves through it. The ledger's `role` column (§6.2) uses the resolved key, so the Budget block's "tokens by role" is trustworthy.
2. **The harvest has a sink.** The archivist posts candidate memories as board records: `kind: finding`, `bean: memory`, addressed to the Lead, confidence labelled (verified / inferred / guess), source cited (bean, commit, file:line). The suite's `harvest memory` case proves ≥1 record per harvested session. §4 consumes this queue.
3. **V2 harvest-or-audit.** The V2 idle path harvests or audits the skip (`oa.harvest.failed`); the V2 event loop is wrapped and audited (`oa.events.failed`).
4. **No phantom tools in prompts.** AFT guidance is conditional on registration; a generator assertion fails if a generated prompt references a tool a default install does not register.
5. **Lease hygiene.** `board_lease_revoke` exists, is Lead-only by permission map, and is audited (`oa.lease.revoke`); doctor lists stale leases and board shows lease age. This is the precondition for parallel worktrees (§3.8).
6. **Compaction is on by default.** `setup` no longer disables it; `--magic-context` is the informed opt-out. The `experimental.session.compacting` hook (§3.5) and the offload compaction job (§9.1) therefore have a real event to catch.
7. **Concurrency state is scoped.** Rungs are keyed by session; re-granting a held glob surfaces `alreadyHeld`. Parallel same-role builders — Phase 2's core scenario — no longer share climb state.
8. **One `ModelLock` type**, zod-validated on read, lives in `@openagentsy/core`.
9. **Config discovery parity.** Doctor reports every OpenCode config file that contributes; setup warns before creating a second active config. §13 extends this to the Phase 2 config files.
10. **The budget loop is closed in prompts.** `roles.yaml` tells the Lead to set a cap per bean and the builder to check before starting and after each milestone. §6.7 makes the numbers real.
11. **Record identity.** `board_record` refuses out-of-vocabulary `from` values and audits the refusal (`oa.record.identity`).
12. **`engines` is bun**, with a friendly runtime guard for Node invocations.
13. **Docs swept**: no ADDENDUM references, the package count is correct, harvest wording is qualified. Every build step's definition of done keeps it that way (§15).
14. **The safety suite runs 14 cases** (the 10 original plus lead-climb, harvest-memory, lease-revoke, budget-stop) plus the record-spoof unit assertion. Phase 2 exit tests extend from this baseline, not past it.

---

## 0. Licensing — landed

The monorepo is GPL-3.0-or-later (`LICENSE`, `NOTICE`, root `package.json`), landed with the toolchain move. The table below still governs Phase 2's new sources:

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

---

## 1. Toolchain — landed, plus residue

### 1.1 Landed state (`eb3a7f1`)

- Bun workspaces over `packages/*`; `bun.lock`; `bunfig.toml` with the isolated linker, exact pins, `minimumReleaseAge`, and `trustedDependencies`.
- Turborepo with `build` / `typecheck` / `test` tasks and the root `//#lint`; `globalDependencies` on `biome.jsonc`, `tsconfig.base.json`, `bunfig.toml`. See the committed `turbo.json` — this spec does not restate it.
- Biome, Husky, lint-staged and `tsc` unchanged from Phase 1; only the commands that run them moved.
- CI runs on Bun with pinned actions by SHA. Reconcile the workflow file name and steps with this spec in 2.0r (the repo's `check.yml` predates this plan).

**One runtime.** OpenCode loads plugins with Bun: the plugin's `$` is Bun's shell, and OpenCode runs `bun install` in its config directories [^tai]. Development, tests and production all run on Bun; `bun:sqlite` is the driver everywhere (§6).

### 1.2 What Phase 1 remediation added on top

- Root `engines` is bun with a runtime guard in the CLI entry (friendly message on Node, exit 1).
- Config discovery parity: doctor reports every OpenCode config file that contributes (root `opencode.json{,c}` and `.opencode/opencode.json{,c}`); setup warns before creating a second active config.
- The audit log streams (`readline`) instead of whole-file reads.

### 1.3 Per-package scripts (unchanged pattern)

```jsonc
// packages/<name>/package.json
{
  "scripts": {
    "build": "bun build src/index.ts --outdir dist --target bun --packages external && tsc -p tsconfig.build.json --emitDeclarationOnly",
    "typecheck": "tsc --noEmit -p .",
    "test": "vitest run"
  }
}
```

- **Sidebar exception.** `packages/sidebar` keeps its Solid JSX transform for `dist/tui.js`. **VERIFY** whether `@opentui/solid`'s Bun plugin works with `bun build`; if not, keep esbuild with `babel-preset-solid` for that one package.
- **Tests stay on Vitest**, started with `--bun` where a package touches `bun:sqlite` (ledger, memory, tasks against the real store); pure packages (footprint, quality's rule functions) run on plain Vitest.

### 1.4 engines matrix (corrected)

| Package kind | engines | Why |
| --- | --- | --- |
| root | `{ "bun": ">=1.2.0" }` (landed) | `bun:sqlite` is load-bearing; nothing runs on Node. |
| host-loaded plugins: `hooks`, `sidebar@1.x`, `sidebar@2.x`, the plugin entry of `tasks`/`memory` | `engines.opencode` **per major**: `1.x → ">=1.19 <2"`, `2.x → ">=2.0 <3"` | OpenCode skips npm plugins whose `engines.opencode` excludes the running version [^tai]. A `<2` ceiling on the 2.x sidebar would make 2.x hosts skip the very package built for them — the previous revision had exactly this bug on every package. |
| libraries: `core`, `models`, `tasks`, `memory`, `footprint`, `ledger`, `quality`, `offload`, `jev`, `mcp` | none (bun only) | An OpenCode engine on a library is meaningless; libraries run wherever Bun runs. |

### 1.5 Expected friction that still applies

- **Phantom imports.** Isolated installs fail on imports a package never declared. Fix by declaring the dependency, never by switching the linker to `hoisted`. Turning `install.hoist = false` on is still a separate, later decision (§16).
- **Native modules.** Phase 2 adds none; `bun:sqlite` is built in.

### 1.6 Step 2.0r — residue

Small, landable as one commit, exit-tested in §15:

1. **Pin the package manager.** Add `"packageManager": "bun@1.3.x"` to the root `package.json` (**VERIFY** the exact pin; turbo reads this field) and a `.bun-version` file.
2. **Decide the catalog.** The migration kept plain `workspaces: ["packages/*"]`; the pnpm-era `catalog:` protocol was not carried over. Either add Bun's catalog for the shared pins (zod, typescript, vitest) or leave plain workspaces and say so in AGENTS.md. Decide once; don't half-migrate.
3. **Script name.** The repo runs `ci:check`; this spec says `check` (`turbo run lint typecheck test build`). Alias one to the other and standardize every doc on the winner.
4. **`CONTRIBUTING.md`.** Create it; it carries the telemetry-off note (`TURBO_TELEMETRY_DISABLED=1` locally and in CI), the Bun prerequisite, and the commit conventions AGENTS.md already implies.
5. **`oa` bin alias.** Add `"oa"` as a second `bin` entry pointing at the same CLI (§2.2). Deprecation-free: `openagentsy` stays canonical.
6. **CI reconciliation.** Align `.github/workflows/check.yml` job steps with §1.1 (setup-bun reading `packageManager`, `bun install --frozen-lockfile`, `bunx turbo run lint typecheck test build`, telemetry disabled).

---

## 2. Package layout and naming

### 2.1 Layout

```
packages/
  tasks/        # .beans-compatible task store + oa_task_* tools + prime injection
  memory/       # inbox over bean:memory records + memory.jsonl + oa_memory_* tools
  footprint/    # EcoLogits-method estimator (pure, no I/O)
  ledger/       # SQLite usage ledger, pricing, waste signals, outcomes
  hooks/        # agentsy HookRegistry adapter, guardrail rules, redaction,
                #   lessons/ (lifecycle + eval runner), recovery-loop checks
  quality/      # rule registry, static checks, comment lint, sloplint bridge, waivers, reviewer gate
  offload/      # local-model router (Ollama / LM Studio) for micro-tasks
  sidebar/      # V2 TUI plugin (dist/tui.js) + V1 server fallback (dist/v1.js)
  adapter-opencode/  # Phase 1: V1/V2 plugin, event bridge, conformance probes.
                #   2a extracts and exports defineTool (§2.3) — no rename.
skills/
  oa-ui/  oa-copy/  oa-comments/     # on-demand quality skills (§10.5)
```

**Dependency direction.**

- `footprint` → `ledger` → `sidebar`.
- `tasks` → `sidebar`; `memory` → `sidebar`.
- `memory` reads its queue through an injected board reader (a `(root) => Promise<Record[]>` over the board db) — it never imports `mcp`, so there is no cycle.
- `hooks` depends only on `@agentsy/runtime`.
- `quality` is pure apart from the optional sloplint spawn. `hooks` calls it.
- `tasks` reads its findings through an injected `openFloorFindings(taskId)`, so there is no import cycle.

`footprint`, `quality`'s rule functions, and the parts of `tasks` and `memory` that do no I/O stay pure, so they can be tested without OpenCode.

### 2.2 Naming (decided once, here)

- **Binary.** `openagentsy` stays canonical; `oa` is an alias bin (§1.6). Slash commands use the short form: `/oa status`, `/oa lessons`, `/oa approve`, `/oa memory`.
- **Tools.** The board's existing tools keep their `board_*` names — they are in shipped permission maps and eval assertions; renaming breaks compat for nothing. New packages prefix `oa_<domain>_*`: `oa_task_*` (§3.6), `oa_memory_*` (§4.4).
- **The `oa-` agent-id prefix** in `roles.yaml` (`oa-builder`) is unrelated legacy from Phase 1 role ids. It is not extended to tools, and tool rules never key on it.
- **MCP-prefixed names.** MCP tools arrive as `<server>_<tool>`. The bridge resolves base names by vocabulary match (§8.2), not by an `oa_`-specific regex — a regex tuned to `oa_` lets `board_*` tools slip past, which is exactly the hole the previous revision's `baseTool` had.

### 2.3 `defineTool` (2a deliverable)

Every Phase 2 tool is defined once and registered on both runtimes. The helper is extracted from the existing V1/V2 registration code in `packages/adapter-opencode` and exported from `@openagentsy/adapter-opencode`:

```ts
// packages/adapter-opencode/src/define-tool.ts
import type { Plugin } from '@opencode-ai/plugin';
import type { z } from 'zod';

export interface ToolDef<A extends z.ZodType> {
  description: string;
  args: A;
  execute: (args: z.infer<A>, ctx: ToolCtx) => Promise<unknown>;
}

/** One definition, two runtimes: V1's tool() shape and V2's registration. */
export function defineTool<A extends z.ZodType>(def: ToolDef<A>): ToolDef<A> { /* extraction in 2a */ }

/** Convert a record of ToolDefs into the V1 plugin's `tool` map and the V2 registration. */
export function toolMap(defs: Record<string, ToolDef<z.ZodType>>): Plugin['tool'] { /* … */ }
```

No package rename, no new package: `@openagentsy/adapter-opencode` already owns both runtime shapes, and the Phase 1 conformance probes live there. The previous revision imported `defineTool` from a `@openagentsy/adapters` package that did not exist; this revision makes the export real before anything imports it. Exit test in §15 (2a): `grep -rn "defineTool" packages/*/src` resolves to definitions and this export only.

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
| Completed beans archived and used as project memory | **Keep.** Archived tasks are committed, greppable Markdown — citable as the `source` of a memory entry (§4.2); no new machinery needed. |
| `Refs: <id>` trailers in commit messages; bean files committed together with the code | **Keep.** This links tasks, commits and the ledger (§6.5). |
| Worktrees kept *outside* the repo (`~/.beans/worktrees/<project>/`), each with a `.meta.json`; `setup` and `run` commands; `integrate: local or pr` | **Adopt** for parallel builders, under `~/.openagentsy/worktrees/<project>/` — with shared board state (§3.9). |
| Status changes in a worktree treated as provisional ("dirty") until its PR merges | **Adopt** (§3.8). |
| Working out which tasks a worktree touched from its git diff | **Adopt** for the Board block. |
| Quick-reply suggestions after each agent turn | **Adopt** through local offload (§9), not a hosted model. |
| Default effort level per project | Already covered by Phase 1's effort ladder; read `agent.default_effort` when it's present. |
| **`beans prime`**: a long guide injected into every system prompt, beginning `<EXTREMELY_IMPORTANT>` and including "You MUST ignore all previous instructions" | **Reject.** It's coercive prompt engineering that gets in the way of other instructions, and it costs tokens on every turn. We inject a short state summary instead (§3.5), move the usage guide into a skill that loads on demand, and enforce the rules in code. |
| An agent chat that spawns Claude Code processes, plus a web UI and GraphQL server | **Reject.** OpenCode is our runtime, and the TUI sidebar is our UI. |
| "You've been programming all your life; now you get to be a product manager." | **Reject the framing.** The person stays the engineer who directs the tools and reviews the work. |
| `default_mode: act`, "fully autonomous" | **Reject as a default.** Agents act, but destructive tools go through the approval hooks (§8). |

The Lead's `roles.yaml` guidance already describes dispatching in terms the current system supports (short bean ids, owned globs, acceptance tests — reworded in the remediation). When 2a lands, the tasks package replaces that prose with the real thing; the guidance then points at `oa_task_*` instead of describing bookkeeping in words.

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
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export class EtagMismatch extends Error {
  constructor(public current: string) { super(`etag mismatch; current=${current}`); }
}

export class TaskStore {
  constructor(private root: string, private prefix: string) {}   // root = <repo>/.beans

  private cache = new Map<string, { task: Task; mtimeMs: number; size: number }>();

  async all(includeArchive = false): Promise<Task[]> {
    // readdir root (+ archive/); for each file, stat first — parse only when
    // (mtimeMs, size) changed. The prime hook calls all() on every message
    // (§3.5); re-parsing 500 files per message is the provider.list() mistake
    // the Phase 1 remediation already fixed once, and we do not reintroduce it.
  }
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

**Performance budget.** The prime renders on **every message** (`chat.system.transform`) and again on compaction. The store's stat-keyed cache (§3.4) makes that an mtime check per file, not a parse. Budget: **p95 ≤ 5 ms at 500 live tasks** on a warmed store; the 2a exit test (§15) measures it from a fixture corpus. A file watcher (`fs.watch` on `.beans/`) may replace the stat sweep later; the budget, not the mechanism, is the contract.

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

Compaction is **on by default** since the remediation (`setup --magic-context` is the informed opt-out), so the compacting hook has a real event to catch. For users who did opt out, the prime still rides `chat.system.transform` every message; nothing is lost, only the compact-time refresh.

On V2, the same `primeBlock` goes through the adapter's system-prompt hook.

### 3.6 Tools

These are registered through `defineTool` from `@openagentsy/adapter-opencode` (§2.3), so V1 and V2 share one definition:

```ts
// packages/tasks/src/tools.ts
import { z } from 'zod';
import { defineTool } from '@openagentsy/adapter-opencode';

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
// openFloorFindings is injected by the plugin entry from @openagentsy/quality (§10.4); tasks never imports quality.
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

### 3.9 Shared state from worktrees (new — resolves the board fork)

A worktree session must not fork the coordination state. Without this section, a builder rooted in `~/.openagentsy/worktrees/<project>/<id>` would resolve a different `.openagentsy/` — its own empty board, its own lock, its own rungs — and every guarantee the system makes about leases, records and budgets would evaporate for exactly the sessions that matter most.

**Resolution rule.** One helper, in core, used by the plugin, the board MCP and the CLI alike:

```ts
// packages/core/src/roots.ts
/**
 * The directory that owns shared OpenAgentsy state (.openagentsy/: board db,
 * leases, rungs, audit log, lessons, memory, waivers, conformance, approvals,
 * ledger) and the model lock. In a linked worktree this is the MAIN repository
 * root (git rev-parse --git-common-dir, minus its trailing .git); anywhere
 * else it is the nearest project root. All state resolves through it, so a
 * builder in a worktree sees the Lead's board.
 */
export function resolveStateRoot(cwd: string): string {
  // git -C cwd rev-parse --git-common-dir  → strip trailing "/.git" → that dir.
  // Not a worktree (common dir === cwd/.git): return cwd. Not a git repo:
  // walk up for .openagentsy/ or the lock file, as the plugin does today.
}
```

What resolves through `resolveStateRoot` and what stays local:

| State | Resolves to | Why |
| --- | --- | --- |
| Board db, leases, audit log, records | **main root** | The board is the single coordination surface; a worktree builder must see the Lead's leases and post to the board the Lead reads. |
| Model lock, rungs | **main root** | The lock is per-project; rungs are per-session (remediation) but stored in one file. |
| Ledger, footprint rows | **main root** | Usage rolls up per project, not per worktree. |
| Lessons, waivers, conformance, approvals, memory.jsonl | **main root** | Policy and durable state are project-wide. |
| `.beans/` task files | **worktree (local)** | By design: task edits travel with the PR, provisional until merge (§3.8). |

**Exit test (2e):** a builder session rooted in a worktree (a) is denied a file the Lead leased on the main board, (b) posts records that appear in the main board's inbox, and (c) its `.beans/` edits exist only in the worktree and clear to authoritative after merge.

The precondition for this to be safe is landed: leases have an admin release path (`board_lease_revoke`, Lead-only) and doctor lists stale leases — without those, worktrees would multiply the stale-lease deadlock the Phase 1 review flagged.

---

## 4. `@openagentsy/memory`: the minimal memory slice (new)

Revision 1 referenced a "Magic Context harvest queue" in the sidebar and an offload job for "the Magic Context `PreCompact` handler" — while no package in any phase built Magic Context, and the Phase 1 review had just flagged exactly this pattern (prompts and blocks consuming machinery that does not exist) as a defect. This section replaces that dependency with a slice we build: small, honest about being small, and forward-compatible with a real historian later.

What this slice is **not**: no historian, no dreamer, no decay, no cache-stable drops, no auto-injection. Those stay out (§14) until the inbox contract below proves itself in real use.

### 4.1 What already exists (landed)

- The archivist posts candidate memories as board records: `kind: finding`, `bean: 'memory'`, addressed to the Lead, confidence labelled, source cited (remediation; suite case `harvest memory`).
- The board's cursor-based record reads (`board_record` inbox semantics) can list them.
- Record identity is guarded (out-of-vocabulary `from` refused) and audited.

So the producer side of the memory pipeline exists and is tested. What is missing is the consumer side: a decision, a store, and a way back in.

### 4.2 Store

`.openagentsy/memory.jsonl` at the state root (§3.9). One JSON object per line, so `grep` and `wc -l` work on it:

```ts
// packages/memory/src/model.ts
export interface MemoryEntry {
  id: string;                                     // oa-mem-<nanoid6>
  text: string;                                   // ≤ 280 chars, enforced on write
  category: string;                               // free-form tag, ≤ 24 chars, task TAG grammar
  source: string;                                 // "<recordId> · <bean|commit|file:line>" — where it came from
  confidence: 'verified' | 'inferred' | 'guess';  // carried from the archivist's label
  created_at: string;                             // ISO 8601
}
```

- **Append-only.** Entries are never edited; a wrong memory is superseded by a new one or removed by a person (`/oa memory <id> forget` — human-only, §8.3).
- **Dedup** on append: fnv1a64 of the normalized text (lowercased, whitespace-collapsed — the tasks package's `etag` helper, reused) against the existing store; a duplicate increments nothing, it is refused with the existing entry's id.
- **Redaction runs first** (§8.4): a candidate that matches a secret pattern is redacted before it can be approved, and the redaction counter increments. The 2a exit test seeds a real-looking key in a candidate and asserts it never appears in `memory.jsonl`.

### 4.3 Inbox and decisions

- **The inbox is the board's pending `bean: memory` records** — records whose `state` is not `promoted` or `rejected`. No second queue, no drift between what the archivist posted and what the inbox shows.
- **Decisions are human-only.** This is the same rule as lessons (§8.5) and waivers (§10.4), enforced the same way:
  - Primary: `roles.yaml` denies `openagentsy_memory_decide` to every agent role (the `board_lease_grant` precedent — the permission map is the mechanism the repo has proven, because the hook cannot see MCP calls on the pinned binary, §8.2).
  - Secondary: the `human-only-decisions` hook rule, for any host where MCP routing through `tool.execute.before` does fire.
- `/oa memory <id> a|r` records the decision: **approve** appends to `memory.jsonl` and marks the record `state: 'promoted'`; **reject** marks it `state: 'rejected'`. Either way the decision is audited under a new policy id `oa.memory.decide` with `decidedBy` set to the human user.
- The sidebar Memory inbox block (§7.4) lists pending candidates with `a` / `r` keys.

### 4.4 Tools

```ts
// packages/memory/src/tools.ts — registered via defineTool (§2.3)
oa_memory_search:  // args: { q: string, category?: string, limit?: int ≤ 8 }
                   // substring/keyword over text + category. The store is small
                   // (target < 10k entries); an in-memory scan over parsed lines
                   // is fine at this size — the same stat-keyed cache pattern as
                   // the task store applies. Optional embedding re-ranking via
                   // offload when a backend exists: OFF by default (§16).
oa_memory_list:    // args: { limit?: int ≤ 20 } — recent entries + pending count, for the block.
```

**No auto-injection in this slice.** Agents search when the task warrants it; the Lead's guidance gains one line ("check oa_memory_search when a bean touches ground you've covered before"). Auto-recall — the historian deciding what to surface per turn — is future work (§14) precisely because doing it badly poisons contexts silently.

### 4.5 Forward compatibility

When a real historian lands (2f or later), `memory.jsonl` migrates into whatever store it brings. The contract that survives is the inbox: candidates arrive as board records, a person decides, refusals and approvals are audited. Anything built against §4.3/§4.4 keeps working; only the store and the search backend change.

### 4.6 Exit tests (2a)

- Round-trip: a harvested candidate → approve → a `memory.jsonl` line exists → `oa_memory_search` finds it by a term in its text.
- A rejected candidate never enters the store; its record shows `state: 'rejected'`.
- An agent calling `oa_memory_decide` — directly and through an MCP-prefixed name — is blocked **with the hook rule disabled** (the map alone must hold; §8.2's lesson).
- A seeded secret in a candidate never reaches `memory.jsonl` (redaction ran first).
- The prime block does not grow (no memory injection): token test.

---

## 5. `@openagentsy/footprint`: the estimator

This package is pure TypeScript with no I/O. Every quantity is an interval, `[lo, hi]`.

### 5.1 Types

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
  outputTokens: number;         // output + reasoning (reasoning counted once; see §6.2)
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

### 5.2 Constants, quoted from the methodology

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

### 5.3 Core math

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

### 5.4 Resolving the model and site

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

### 5.5 Tests

- **Golden test.** For 20 fixed `(model, usage)` pairs, run the Python `ecologits` library offline once with `scripts/golden.py` and commit the JSON. Our point estimates (using range midpoints and a dense model) must match within 1%.
- **Worked example as a unit test.** P_total 300B, P_active 30B, 150k output tokens, 60 tok/s, PUE 1.2 and a 0.4 kg/kWh grid must give:
  - 16 GPUs;
  - 5.76e-5 Wh/token/GPU;
  - 138.3 Wh on GPUs, 26.0 Wh for the rest of the server, 197.2 Wh in total;
  - 78.9 g CO₂;
  - 3.55e-17 °C at the best-estimate TCRE.
- **Property tests.** For every output, `lo ≤ hi`. Energy never decreases as tokens increase.

---

## 6. `@openagentsy/ledger`: tokens, cost, waste, outcomes

The ledger stores **numbers only**: token counts, model IDs, timestamps, task IDs and commit SHAs. It never stores prompts, completions or code, which follows TokenTracker's privacy rule [^tt]. Transcripts stay in OpenCode's own storage.

### 6.1 Schema (`.openagentsy/ledger.db`, SQLite, at the state root §3.9)

```sql
CREATE TABLE IF NOT EXISTS usage (
  message_id      TEXT PRIMARY KEY,        -- dedup key (OpenCode message id)
  session_id      TEXT NOT NULL,
  root_session_id TEXT NOT NULL,           -- Lead session; subagents roll up here
  role            TEXT,                    -- RESOLVED role key: lead | scout | researcher | builder | reviewer | advisor | archivist | offload
  role_raw        TEXT,                    -- unresolved agent id, backfilled rows only; excluded from per-role reports (§6.2)
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

**The `role` column stores the resolved role key**, never the raw agent id. The Phase 1 remediation fixed the resolver (`roleKeyForAgent`); the ingest path normalizes through the adapter's resolution before writing. The Budget block's "tokens by role" and every per-role report inherit correctness from this one rule — the previous revision inherited the CRITICAL bug instead, by not stating it.

### 6.2 Ingest

```ts
// packages/ledger/src/ingest.ts
import { Database } from 'bun:sqlite';                // one runtime everywhere (§1); no native sqlite dependency

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

`ctx.role` arrives **already resolved** from the adapter (the landed resolver); the ledger never sees `agentsy` where it means `lead`.

Field names (`providerID`, `modelID`, `tokens.cache.read`) follow OpenCode's message shape as read by streetturtle's `session-tokens` plugin [^bs]. That plugin reads `message.model.id` on V2. **VERIFY** both shapes in the Phase 1 adapter, and normalise them there.

**Backfill (optional, opt-in).** Open `~/.local/share/opencode/opencode.db` read-only, plus any `opencode-<channel>.db`, and skip the `-wal`/`-shm` sidecars, as tokscale does [^tokscale]. Import past sessions with `INSERT OR IGNORE`. **VERIFY** the table schema for the OpenCode version you pin; it is internal and can change. Backfill cannot resolve role keys for imported messages (the raw agent id is all that exists there); those rows carry the unresolved id in a `role_raw` column and are excluded from per-role reports rather than mis-attributed.

### 6.3 Pricing chain

Prices are tried in this order, and the first hit wins:

1. `message.cost` reported by OpenCode;
2. models.dev `cost.{input,output,cache_read,cache_write}` per 1M tokens;
3. LiteLLM's pricing JSON;
4. OpenRouter's endpoints API;
5. `NULL`, shown as "unpriced", never as `$0`.

Every source is cached for 24 hours on disk under `~/.cache/openagentsy/pricing/`. A copy bundled at build time covers offline use. Tiered pricing (rates that change above a token threshold) is respected when the source provides it.

### 6.4 Waste signals (agent waste, not user scoring)

| Signal | Detection (specified) | Tokens counted |
| --- | --- | --- |
| `retry` | The same tool with the same normalised args within 3 calls, after an error | The repeated call's turn |
| `tool_error_loop` | 3 or more consecutive tool errors in one subagent | Those turns |
| `interrupted` | The user cancels a turn mid-stream (OpenCode abort event) | That turn's tokens |
| `undo` | `/undo` or a revert of the agent's last change | Tokens of the undone turn |
| `reverted_code` | `oa ledger scan-reverts`: walks `git log --since` for `Refs:`-trailed commits whose changed lines are deleted again within 14 days (`git log -L` / blame diff). **A command, not a daemon**: run by the person or the Lead on demand; users who want it nightly schedule it themselves. | Builder tokens for that task × the share of lines lost |
| `cache_miss` | A turn with **no new user parts since the previous assistant message** (a retry or continuation — detectable from the message list: same parent, no intervening user message) whose `cache_read / (input + cache_read)` is below 0.5. The prefix was unchanged by definition, so a low cache ratio is the model's problem, not the user's. | Uncached input |
| `no_progress` | A Lead round that dispatched nothing, consumed no results and changed nothing on the board (§8.7) | The round's tokens |

**There is no "frustration score" about the person.** The Budget block shows "18% of tokens went to retries, undos and reverted code". It never characterises the user.

### 6.5 Outcomes: tokens per result

Outcomes are filled in from three sources:

- task transitions (`completed`, `scrapped`) in the tasks store;
- `Refs: <task-id>` trailers found by `git log --since` — the pre-commit hook requires the trailer on agent commits (`OPENAGENTSY_AGENT=1`, §8.3);
- PR merges seen by the `pr` integration mode.

From those, the ledger reports **tokens per completed task** and **tokens per merged commit**. These are the Phase 2 exit metrics, compared with Phase 1 and with plain OpenCode. The idea is TokenTracker's "effective tokens" outcomes sidecar, applied to task results [^tt].

```sql
-- tokens per completed task, last 30 days
SELECT o.task_id, SUM(u.input + u.output + u.reasoning + u.cache_write) AS tokens, SUM(COALESCE(u.cost_reported, u.cost_estimated)) AS usd
FROM outcome o JOIN usage u ON u.task_id = o.task_id
WHERE o.kind = 'task_completed' AND o.ts > datetime('now','-30 days')
GROUP BY o.task_id;
```

### 6.6 Exports

`oa ledger export --json` writes the counters only, using a schema documented in `packages/ledger/SCHEMA.md`. Because tokscale and TokenTracker already read OpenCode's own database, people who use those tools get the same sessions without any work from us. Nothing is uploaded. There is no leaderboard, streak or achievement feature (§14).

### 6.7 Budgets: caps in the board, usage in the ledger (reconciliation)

Phase 1 shipped two budget mechanisms and never reconciled them: the board's self-reported `recordUsage` (overwrite semantics, guarded but still self-reported) and the prompt guidance telling the Lead to set caps and builders to check them. Phase 2 makes the split clean:

| Concern | Owner | Mechanism |
| --- | --- | --- |
| The **cap** (how many tokens a bean may spend) | the board | `board_budget_set` — permission-mapped to the Lead, as landed. A target someone chose. |
| The **usage** (how many tokens were actually spent) | the ledger | measured per message (§6.2), summed by `task_id`. Nobody self-reports anything. |
| The **stop verdict** | the board, computed | `board_budget op=check` reads the bean's usage **from the ledger** and compares it to the cap. The boolean the builder is told to obey (roles.yaml, landed) is now backed by measured numbers. |

- The board's `recordUsage` self-reporting path is **deprecated in 2b** (it keeps working, audited, for old clients) and **removed in 2c**. The landed monotonic guard made it safe; the ledger makes it unnecessary.
- Exit test (2b): a budget-stop scenario where the ledger records usage the builder never self-reported, and the stop verdict fires on the measured number.

---

## 7. `@openagentsy/sidebar`: TUI blocks

### 7.1 V2 entry point

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

### 7.2 Shared hook: usage for the whole session family

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

### 7.3 Footprint block

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

  const t = () => ctx.theme;                      // normal text colours only — no alarm colours (§7.6)
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

### 7.4 Other blocks (data sources — every source exists in this plan)

| Block | Reads | Notes |
| --- | --- | --- |
| Board | The board MCP's counts-only poll (Phase 1), plus `detectTaskIds` per worktree (§3.8) | Provisional task states are shown dimmed. Leases show age; `board_lease_revoke` (landed) is one keypress away for the Lead. |
| Tasks | `TaskStore.all()` through the §3.5 cache; a file watcher on `.beans/` refreshes it | Shows in-progress, the next 3 ready tasks, and how many are blocked. Mouse-down on a row inserts `oa_task_show <id>` into the prompt. **VERIFY** the prompt-insert API. |
| Budget | `ledger.db` for this root session (§6) | Tokens **by resolved role**, cache hit rate, waste %, tokens per completed task, offload savings. Cap vs measured usage per bean (§6.7). |
| Memory inbox | The board's pending `bean: memory` records (§4.3) — the queue the archivist actually fills | Each candidate gets `a` (approve) or `r` (reject). **VERIFY** `context.keymap.layer` → capability `memory-inbox-keymap` (§11). Rejected candidates never enter memory. |
| Accountability | The `outcome` table, the redaction counter, the hook audit log, lessons awaiting a decision (§8.5), memory decisions pending (§4.3), board/report mismatch flags (§8.7), quality waivers (§10.4) and the conformance count (§11) | For example: "3 lessons to review · 1 memory to triage · 2 waivers · conformance 10/17 observed". Links to `oa report --ethical` (§12). |

### 7.5 Collapse persistence

```ts
// packages/sidebar/src/persist.ts
// One small JSON file per user. VERIFY whether the TUI plugin API exposes a KV store (Mangome's plugin persists state);
// if it does, use it instead of the file.
const FILE = join(homedir(), '.config', 'openagentsy', 'sidebar.json');
export function useCollapsed(key: string, initial: boolean): [() => boolean, () => void] { /* signal + debounced write */ }
```

### 7.6 Framing rules, as code review checks

- Blocks only use `theme.text.base` and `theme.text.muted`. A unit test that scans the block JSX (or a project-local `packages/quality` rule) fails if a footprint block references `theme.error` or `theme.warning`.
- No copy contains "you", "your fault", "streak", "today you" or a comparison with other users. A unit test checks this against a list of banned words.
- `footprint.showWarming` defaults to `true`, and can be set to `false` in `openagentsy.jsonc`.

### 7.7 V1 fallback

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

- `@openagentsy/sidebar@2.x` exports `dist/tui.js`, with `@opentui/solid` and `solid-js` as peer dependencies. The build is `bun build` with the Solid transform, or esbuild with `babel-preset-solid` for this package only (§1.3).
- `@openagentsy/sidebar@1.x` exports `dist/v1.js`.
- **One package per runtime.** OpenCode rejects a module whose default export has both `server` and `tui` [^tai], so a single package can't serve both.
- **Engines per §1.4**: `1.x → ">=1.19 <2"`, `2.x → ">=2.0 <3"`. A `<2` ceiling here would make 2.x hosts skip the 2.x sidebar — the exact mistake revision 1 generalized to every package.
- **V1 loading rules.** A V1 user lists the package under the **singular** `plugin` key in `opencode.json`. The plural `plugins` key is V2's name; V1 drops it with only a log warning, so plugins listed there never load.

---

## 8. `@openagentsy/hooks`: deterministic guardrails

### 8.1 Use agentsy's registry directly

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

### 8.2 OpenCode bridge — the facts, as measured

**How OpenCode calls plugin hooks.** The table below mixes two kinds of fact: what the generated source table says [^tai], and what this repo has **measured** on the pinned binary. Where they disagree, the design follows the measurement — that disagreement is not hypothetical; it is why Phase 1's permission map exists.

| agentsy event | OpenCode 1.x hook | Can it block or change the call? |
| --- | --- | --- |
| `PreToolCall` | `tool.execute.before (input{tool,sessionID,callID}, output{args})` | **Built-in tools (write, edit, bash, …): yes.** Throw to stop the call; mutate fields of `output.args` **in place** — assigning a new object to `output.args` has no effect. **MCP tools: [measured] does not fire on the pinned binary.** The v1.19.4 source table routes MCP calls through this hook as `<server>_<tool>` [^tai], but the Phase 1 measurement found it does not fire, and the README records this as "Decisions that differ" #2 — the permission map was built because of it. **Design rule: no security property may depend on this hook firing for an MCP call.** Conformance capability `mcp-tool-prefix` (§11) stays `unverified` until observed on a pinned version. |
| `PostToolCall` | `tool.execute.after (input{…,args}, output{title,output,metadata})` | It can rewrite what the model sees, because `output.output` is writable. A throw shows the model a tool error, but the tool has already run. |
| `UserPromptSubmit` | `chat.message` | It can change `output.parts`. |
| `PreCompact` | `experimental.session.compacting` | It can push to `context` or replace `prompt`. Compaction is on by default since the remediation, so this hook has a real event to catch. |
| `PreResponse` | `experimental.text.complete (output{text})` | It can flag the text, or annotate it. Output checks (§8.6) only flag. |
| Model-call params | `chat.params` / `chat.headers` | The effort ladder sets `maxOutputTokens` here (landed). |
| Shell environment | `shell.env (input{cwd,sessionID}, output{env})` | It controls the environment of agent shells (§8.3). |
| `SubagentStop`, `session.idle`, `PostResponse` | `event` | **Observe only.** OpenCode doesn't await the `event` hook, so nothing that must block can live here. |
| Permission decisions | `permission.ask` | **Unusable.** It's declared in the types, but nothing in v1.19.4 calls it (anomalyco/opencode#7006). |

Two more facts shape the code:

- **Plugins run one after another on the same `output` object.** A plugin loaded after ours could change `args` after our checks pass. `oa conformance` lists any other loaded plugin with a `tool.execute.before` hook as a warning (§11).
- **Hook facts are pinned, not permanent.** The bridge is written against the table above; `oa conformance` (§11) is how a new OpenCode version tells us the table moved. `args-mutate-in-place` and `mcp-tool-prefix` are capabilities precisely because they are the two facts most likely to drift.

The `stop` hook that some guides show [^jl] isn't in v1.19.4's hook table, so OpenAgentsy doesn't use it. Two other guides show shapes that don't match the source, and neither shape is used: a nested `tool: { execute: { before } }` object with a `plugins` key [^devto], and an `output.abort` field [^zeke].

**Resolving base tool names.** MCP tools arrive as `<server>_<tool>`. Revision 1 stripped the prefix with a regex tuned to `oa_` (`/^[a-z0-9-]+_(?=oa_)/i`) — which let every `board_*` tool through untouched, exactly the class of hole the permission map exists to close. The bridge resolves base names against the **registered tool vocabulary**, by longest-suffix match:

```ts
// packages/hooks/src/base-tool.ts
import { boardToolNames } from '@openagentsy/core';                 // board_record, board_lease, board_lease_grant,
                                                                    // board_lease_revoke, board_budget, board_budget_set,
                                                                    // board_classify (landed set)
import { taskToolNames } from '@openagentsy/tasks';                 // oa_task_*
import { memoryToolNames } from '@openagentsy/memory';              // oa_memory_*

const VOCAB = [...boardToolNames, ...taskToolNames, ...memoryToolNames]
  .sort((a, b) => b.length - a.length);                             // longest first, so suffix match is unambiguous

/** "openagentsy-board_board_record" → "board_record"; "oa_task_list" → "oa_task_list". */
export const baseTool = (name: string) => VOCAB.find((t) => name === t || name.endsWith(`_${t}`)) ?? name;
```

```ts
// packages/hooks/src/v1.ts
import type { Plugin } from '@opencode-ai/plugin';

export const OpenAgentsyHooks: Plugin = async ({ directory, client }) => {
  const reg = createOaRegistry(defaultRules({ workspace: directory }));
  await client.app.log({ body: { service: 'openagentsy', level: 'info', message: 'hooks loaded' } });  // conformance: plugin-loaded (§11)
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
    'shell.env': async (_input, output) => { applyShellEnvPolicy(output.env); },  // §8.3
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
type ToolArgs = Record<string, unknown>;        // the SDK hands us unknown shapes; narrow, never `any`

export function changedFiles(tool: string, args: ToolArgs): FileChange[] {
  if (!WRITE_TOOLS.has(tool)) return [];
  if (tool === 'apply_patch' || tool === 'patch') return parsePatchHeaders(pickString(args, 'patchText', 'patch') ?? '');
  const path = pickString(args, 'filePath', 'file_path', 'path');
  return path ? [{ operation: tool === 'write' ? 'add' : 'modify', path }] : [];
}
```

- **Rules use `e.files`.** `workspace-writes-only`, `protect-policy`, `secret-scan-writes` and the quality hook (§10.4) all read `e.files`, never a single `targetPath`.
- **Why this matters for `apply_patch`.** One patch can touch several files, including a protected one, or rename a file into a protected path. The before-hook has to parse the patch headers itself, because the tool hasn't run yet.
- **Tested.** A fixture patch that changes `src/a.ts` and also moves a file onto `roles.yaml` must be blocked.

**Model output can't override a blocking rule.**

- Blocking rules run inside the plugin process, before the tool runs — for the tools where the hook fires (built-ins). For MCP tools, blocking lives in the permission map (§8.3), which no model output can touch either.
- The only way past one is a person editing `openagentsy.jsonc` or `roles.yaml` — both PROTECTED (§8.3). An agent's attempt to edit either is blocked and audited.

### 8.3 Default rules

```ts
// packages/hooks/src/rules.ts
// --no-verify anywhere in a git commit/merge/rebase segment; bare `-n` only when it directly
// follows `git commit` (revision 1's /\s-n\b/ false-positived on `git commit -m "fix -n handling"`).
const GIT_SKIP_HOOKS =
  /\bgit\b[^|;&]*\b(commit|merge|rebase)\b[^|;&]*\s--no-verify\b|\bgit\s+commit\s+-n\b|\bHUSKY=0\b|\bcore\.hooksPath\b/;
const OTHER_PM = /(^|[\s;&|(])(pnpm|yarn|npx|npm\s+(i|install|ci|add|exec))\b/;

// The trust boundary is wider than revision 1 had it: roles.yaml IS the permission
// map's source, the .opencode/ tree holds the generated agent files the runtime
// loads, opencode.json carries host permissions, workflows run CI, templates
// regenerate the agents, and the model lock is generated by `openagentsy models init`.
const PROTECTED_FILE = /(^|\/)(roles\.yaml|openagentsy\.models\.lock\.json|openagentsy\.jsonc|biome\.jsonc|turbo\.json|bunfig\.toml|bun\.lock|opencode\.json|opencode\.jsonc)$/;
const PROTECTED_DIR = /(^|\/)(\.opencode\/|\.husky\/|\.github\/workflows\/|templates\/)/;
const PROTECTED_STATE = /(^|\/)\.openagentsy\/(lessons\/|quality\/waivers\.json|conformance\.json|memory\.jsonl|approvals\.json)/;
const isProtected = (p: string) => PROTECTED_FILE.test(p) || PROTECTED_DIR.test(p) || PROTECTED_STATE.test(p);

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
    handler: async (e) => e.files.some((f) => isProtected(f.path) || (f.fromPath && isProtected(f.fromPath)))
      ? { continue: false, reason: 'Policy, role, permission, build-config, lockfile, hook, workflow, lesson and waiver files are changed by a person (or, for bun.lock, by `bun add`; for roles.yaml and templates, by running the generator). Propose the change in chat.' }
      : { continue: true } },

  // Human-only decisions: agents may propose lessons, waivers and memory promotions,
  // never decide them (§4.3, §8.5, §10.4). PRIMARY enforcement is the permission map —
  // roles.yaml denies these three tools to every agent role — because the hook cannot
  // see MCP calls on the pinned binary [measured] (§8.2). This rule is defense-in-depth
  // for built-in-tool paths and for any host where the MCP routing does fire.
  { id: 'human-only-decisions', event: 'PreToolCall', block: true,
    handler: async (e) => ['oa_lesson_decide', 'oa_quality_waive', 'oa_memory_decide'].includes(e.toolName)
      ? { continue: false, reason: 'Lesson decisions, quality waivers and memory promotions are recorded by a person (/oa lesson, /oa waive, /oa memory). Propose it in chat with your evidence.' }
      : { continue: true } },

  { id: 'secret-scan-writes', event: 'PreToolCall', block: true,
    handler: async (e) => e.files.length && findSecrets(contentOf(e)).length
      ? { continue: false, reason: 'The content contains what looks like a credential. Use an env var or secret reference.' }
      : { continue: true } },

  { id: 'destructive-needs-approval', event: 'PreToolCall', block: true,
    handler: approvalGate(/(^|\s)(rm\s+-rf|git\s+push\s+--force|git\s+reset\s+--hard|drop\s+table)\b/i) },
];
```

**Corresponding `roles.yaml` additions (the primary enforcement).** Deny by tool name, for every agent role, mirroring the landed `board_lease_grant` pattern: `openagentsy_lesson_decide`, `openagentsy_quality_waive`, `openagentsy_memory_decide`. The 2c exit test proves the guarantee **in both directions**: (a) with the hook rule disabled, the permission map alone blocks the call; (b) with the maps regenerated without the denies, the hook rule still blocks it. A security property is proven when each layer holds alone, not when both hold together.

**Sanctioned write paths.** `roles.yaml`, `templates/` and the generated agent files change by running `openagentsy build` / `openagentsy models init` — a person runs the generator, the generator writes the files. To make out-of-band edits visible anyway, doctor (extended in 2c) gains a **regeneration-diff check**: it regenerates into a temp directory and diffs against the installed `.opencode/agent/` files; a mismatch is a warning naming the exact reconcile command. The landed doctor already checks config discovery and lease staleness; this extends the same posture to the permission maps themselves.

**Approvals, given that `permission.ask` is never called.** A plugin can't answer OpenCode's permission prompt, so the approval flow has two parts:

1. **Ask through OpenCode's own permission config.** The plugin's `config` hook merges *tightening-only* entries into OpenCode's `permission` config, for example `"bash": { "git push*": "ask", "gh pr merge*": "ask", "bun add *": "ask" }`. These come from `hooks.approvalFor` (§13). OpenCode then shows its normal prompt, and the person answers it.
   - The merge can change `allow` → `ask` or `ask` → `deny`, never the other way round. A unit test checks that.
   - **VERIFY** that changes made in the `config` hook reach the permission evaluator in the pinned version. If they don't, `oa init` writes the same entries into `opencode.json`, and that edit is shown to the person as a diff.
2. **Block anything the permission config can't express.** Examples are `rm -rf` inside a compound command, and SQL in a heredoc. `approvalGate` throws in `tool.execute.before` with a reason naming the escape hatch: `/oa approve <callID>`.
   - **`/oa approve` storage and TTL (specified).** The command appends `{ callID, expiresAt }` to `.openagentsy/approvals.json` at the state root (§3.9; the file is PROTECTED above). `approvalGate` checks the list before throwing: a matching, unexpired entry passes **once** and is removed; expired entries are pruned on read. Every grant and use is audited (`oa.approve.granted`, `oa.approve.used`), so the approval trail is on the record like everything else.

**Plugin versus YAML shell hooks.** opencode-yaml-hooks [^yamlhooks] and openhooks [^openhooks] let people declare shell hooks in YAML. In opencode-yaml-hooks, a script exiting with code 2 blocks the tool. We don't ship a YAML layer, for three reasons:

- **Environment.** Those actions inherit the full `process.env`. Our rules run in-process instead, with `shell.env` tightening what shells receive.
- **One source of rules.** A second rule language would split where policy lives.
- **Nothing is lost.** People who want YAML hooks can install either plugin alongside ours. `oa conformance` will list it in the plugin-order warning (§11).

Two ideas from them are adopted: the `file.changed` normalisation above, and opencode-yaml-hooks' `scope: main | child`. Our version is `Rule.roles?: Role[]`, for example a rule that applies only to builder subagents.

**Shell environment policy.**

```ts
/** shell.env: what every agent shell sees. Tightens only; never adds credentials. */
export function applyShellEnvPolicy(env: Record<string, string>) {
  for (const k of ['HUSKY', 'HUSKY_SKIP_HOOKS', 'SKIP_SIMPLE_GIT_HOOKS', 'TOGETHER_API_KEY', 'TYPESAFE_API_KEY']) delete env[k];
  env.TURBO_TELEMETRY_DISABLED = '1';
  env.OPENAGENTSY_AGENT = '1';      // lets the pre-commit hook require a Refs: <task-id> trailer on agent commits (§6.5)
}
```

`TYPESAFE_API_KEY` joins the strip list: the classifier's key belongs to the board MCP process, never to an agent shell. (The classifier's data egress — request text to `api.typesafe.ai` when the key is set — is documented in the README since the remediation; §14 keeps that honest by refusing hidden network calls everywhere else.)

### 8.4 Secret redaction when anything is written to storage

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

`redact()` runs on everything that gets stored: board records, harvested memory candidates (before they can be approved, §4.2), `memory.jsonl` writes, archived task bodies and Accountability reports. Each redaction increments the counter shown in the Accountability block. The test fixtures include a key with real secret shape, which must never appear in `.openagentsy/` after a scenario run.

### 8.5 Lessons: reviewed self-improvement

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

An `instructions` or `memory` owner needs a one-line `ownerJustification` explaining why code or a skill can't hold the lesson. This follows the same Hook/Prompt Axiom as the rest of §8.

**Capture.** The archivist creates candidates in two cases:

- the same waste kind with similar normalised detail appears in 3 or more sessions (§6.4);
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

- `oa_lesson_decide` is denied to every agent role by the permission map (§8.3, primary) and by the `human-only-decisions` rule (defense-in-depth).
- `/oa lessons` is the inbox, sorted by occurrences and recency.
- `/oa lesson <id> validate|apply|reject|observe` records the decision, with `decidedBy` set to the human user.
- **No lesson changes an instruction, skill or role file without a human decision.** The red-team exit test checks this — with the hook disabled, the map alone must hold.

### 8.6 Output checks (from agentsy SAFETY.md)

These run as `PreResponse` handlers, and they **flag** rather than block:

| Check | Detector |
| --- | --- |
| Sycophancy | Phrases that praise or agree with the user, followed by no change in position after the user pushes back. Measured against a reviewer verdict. |
| Anthropomorphising | First-person claims of feelings or experiences ("I feel", "I'm excited"). |
| Dependency | "You don't need to understand this" or "just let me handle it" language. |
| AGI or longtermist framing | Phrases claiming the system replaces engineers, or calling the work "superintelligence". |
| Scope drift | Files touched outside the active task's stated paths, or tool calls unrelated to the task title. Uses an embedding check from the offload model. |

Flags go to the Accountability block and to `oa report --ethical` (§12). The person decides what to do about them.

### 8.7 Lead recovery loop

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
- **The report must match the board.** An observer on `session.idle` compares the status the Lead claims in its last message with the board's round status. A mismatch is flagged in the Accountability block. The `event` hook isn't awaited (§8.2), so this check can only flag a mismatch, never block it.
- **A round that changed nothing can't claim progress.** A round that dispatched nothing, consumed no results and changed nothing on the board writes a `no_progress` waste event (in the `waste.kind` CHECK constraint, §6.1).

The loop rides two landed fixes: role resolution (the Lead's rounds are attributed to `lead`, not `agentsy`) and session-scoped rungs (a recovery round doesn't move another session's effort ceiling).

---

## 9. `@openagentsy/offload`: local models for housekeeping

### 9.1 What gets offloaded

| Job | Caller | Output contract |
| --- | --- | --- |
| Session and task titles | sidebar, tasks | `{ title: string ≤ 60 chars }` |
| Compaction summaries | **our own `experimental.session.compacting` hook** (§3.5): when the job is enabled, the hook asks the local model to draft the compacted context and pushes it to `output.context`; disabled (default), stock OpenCode compaction runs untouched. Optional quality upgrade, never a dependency — compaction works without any local backend. **VERIFY** the hook's write contract on the pinned version → capability `compaction-hook` (§11). | `{ summary: string ≤ 1200 chars, keep: string[] }` |
| JSON repair for tool arguments | adapters | the target zod schema |
| Classification (task type, waste kind, scope-drift similarity) | tasks, ledger, hooks | an enum |
| Quick replies after a turn (idea from Beans [^beans]) | sidebar | `{ replies: string[] ≤ 4, each ≤ 10 words }` |

Revision 1 listed "the Magic Context `PreCompact` handler" as the caller for compaction summaries — a handler no phase builds. The caller is now our own hook (§3.5), which exists in this plan, and the job is off by default (`offload.jobs` config, §13).

### 9.2 Router

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

## 10. `@openagentsy/quality`: anti-slop checks

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

- Taste rules stay warnings, so OpenAgentsy never imposes one aesthetic. They include: eyebrows and tracked capitals; an italic word in a heading; Lucide icons, bento grids and 3-step "how it works" sections; em dashes.
- `DESIGN.md` / `design.md` is read as **data, not instructions** (antislop's boundary rule). Text inside it can change which taste rules apply, but it can't turn off a floor rule or tell the agent to do anything.

### 10.1 Rule registry

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

### 10.2 Static checks

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

**Claims.** An unsourced claim is a floor finding, because a made-up number is an honesty failure. It's resolved by adding a source comment (`<!-- source: … -->`) or a `data-placeholder` marker. Deleting the copy isn't required. Hallmark's "material inventory" in `oa-ui` (§10.5) is there to stop the agent inventing claims in the first place.

### 10.3 Comment lint (antislop-code)

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

### 10.4 Hooks, findings and waivers

```ts
// packages/hooks/src/rules.ts (addition)
{ id: 'quality-after-write', event: 'PostToolCall', block: false,
  handler: async (e) => {
    if (!e.files.length || cfg.quality.mode !== 'during') return { continue: true };
    const paths = e.files.filter((f) => f.operation !== 'delete').map((f) => f.path);   // all files an apply_patch touched (§8.2)
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
- Only a person records one, with `/oa waive <ruleId> <path> "<reason>"`. `oa_quality_waive` is denied to every agent role by permission map (§8.3, primary) and blocked by the hook rule (defense-in-depth).
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

### 10.5 Skills, loaded on demand

Each SKILL.md is ≤ 1,500 tokens, with detail kept in reference files the skill links to.

| Skill | Loads when | Contents |
| --- | --- | --- |
| `oa-ui` | A change touches `.css`, `.html`, `.tsx`/`.jsx`/`.vue`/`.svelte` or design files | antislop's purpose test ("what does this technique serve?"), with the reason written down. The ENERGY, RHYTHM and MOTION dials and the Design Read. Hallmark's material inventory: what's real, which pictures exist, what's absent; no invented facts, honest placeholders. "Build from the job": start from the page's primary action. Read `DESIGN.md` first; with no direction, label the output "draft without direction". |
| `oa-copy` | User-facing copy, **or agent prose**: commit messages, PR descriptions, the task "Summary of Changes", Lead status reports | antislop-copywriting: specific calls to action, no buzzwords, no fake stats. |
| `oa-comments` | Comments are edited | antislop-code's tells and its preserve list. It's the counterweight to §10.3. |

**Routing.** At most 80 tokens are added to the Lead and builder roles: "For UI, copy or comment work, load oa-ui / oa-copy / oa-comments. Mechanical checks run automatically." A token test confirms that **no quality skill loads** when no matching file is touched.

### 10.6 Reviewer gate

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

- **The reviewer starts fresh.** It runs in a new context, using a different model family from the builder. It sees only: the diff; `DESIGN.md`; the check results. It never sees the builder's transcript.
- **A false pass is a finding.** If the reviewer says "ship" while a floor finding is open, that's recorded as a finding of its own, and it goes to the Accountability block.

---

## 11. `oa conformance`: what's proven, observed or unverified

This is adapted from agent-playbook's host-conformance states [^apb]. `oa conformance` (a command and a tool) reports each capability **separately for V1 and V2**, with one of three states:

| State | Meaning |
| --- | --- |
| `proven_static` | The files and config are present, the plugin loads and its schema validates. |
| `observed` | Seen working in a real session. Bounded evidence (event type, timestamp, session ID) is stored in `.openagentsy/conformance.json`. |
| `unverified` | Neither of the above. |

```ts
// packages/adapter-opencode/src/conformance.ts
export interface Capability { id: string; host: 'v1' | 'v2'; verifyRef?: string;   // spec anchor of the VERIFY it settles
  probeStatic: () => Promise<boolean>; observeOn: OcEventType[] }

export const CAPABILITIES: Capability[] = [
  { id: 'sidebar-slot', host: 'v2', verifyRef: '§7.1', probeStatic: hasTuiEntry, observeOn: ['tui.slot.render'] },
  { id: 'v1-toast', host: 'v1', verifyRef: '§7.7', probeStatic: hasV1Entry, observeOn: ['tui.toast.show'] },
  { id: 'system-transform', host: 'v1', probeStatic: hasHook('experimental.chat.system.transform'), observeOn: ['chat.system.transformed'] },
  { id: 'compaction-hook', host: 'v1', verifyRef: '§9.1', probeStatic: hasHook('experimental.session.compacting'), observeOn: ['session.compacted'] },
  { id: 'tool-before-block', host: 'v1', probeStatic: hasHook('tool.execute.before'), observeOn: ['tool.execute.before'] },
  { id: 'session-family', host: 'v2', verifyRef: '§7.2', probeStatic: hasApi('session.family'), observeOn: ['session.family.read'] },
  { id: 'message-token-fields', host: 'v2', verifyRef: '§6.2', probeStatic: alwaysFalse, observeOn: ['message.updated'] },
  { id: 'prompt-insert', host: 'v2', verifyRef: '§7.4', probeStatic: hasApi('prompt.insert'), observeOn: ['prompt.inserted'] },
  { id: 'local-offload', host: 'v2', verifyRef: '§9.2', probeStatic: probeBackends, observeOn: ['offload.completed'] },
  { id: 'plugin-loaded', host: 'v1', probeStatic: hasV1Entry, observeOn: ['app.log:openagentsy hooks loaded'] },  // a setup throw is skipped silently [^tai]
  { id: 'args-mutate-in-place', host: 'v1', probeStatic: alwaysFalse, observeOn: ['oa.selftest.args'] },          // seeded no-op rewrite seen by the tool
  { id: 'permission-config-merge', host: 'v1', verifyRef: '§8.3', probeStatic: alwaysFalse, observeOn: ['permission.asked'] },
  { id: 'permission-ask-hook', host: 'v1', probeStatic: alwaysFalse, observeOn: ['oa.permission.ask.called'] },     // expected to stay unverified (#7006)
  { id: 'text-complete-hook', host: 'v1', probeStatic: hasHook('experimental.text.complete'), observeOn: ['oa.text.complete'] },
  { id: 'shell-env-hook', host: 'v1', probeStatic: hasHook('shell.env'), observeOn: ['oa.shell.env'] },
  { id: 'mcp-tool-prefix', host: 'v1', probeStatic: alwaysFalse, observeOn: ['tool.execute.before:<server>_board_*'] },   // §8.2: source says routed, measurement says not; unverified until observed
  { id: 'memory-inbox-keymap', host: 'v2', verifyRef: '§7.4', probeStatic: alwaysFalse, observeOn: ['keymap.layer.memory'] },
  // … one entry per remaining VERIFY in this spec
];
```

- **Every OpenCode-API VERIFY needs a check.** A test greps this spec for **VERIFY** and splits them by kind: API VERIFYs (hooks, SDK shapes, host surfaces) must have a `verifyRef` in `CAPABILITIES`; data and tooling VERIFYs (the EcoLogits license, the `packageManager` pin, the provider-table values) must be named in the exit test of the step that consumes them (§15). Nothing marked VERIFY is allowed to dangle.
- **`observed` is only set from live evidence.** It's recorded by an event listener during a real session, never from a static probe.
- **The Accountability block shows the count**, for example "conformance 10/17 observed".
- **Plugin-order warnings** (`pluginOrderWarnings`) appear in `oa conformance` and in `oa report --ethical` (§12). That's where a person learns that a YAML-hook plugin or another guard runs after OpenAgentsy's checks.

```ts
/** Warn when another plugin could rewrite args after our checks: hooks share one output object, in load order. */
export function pluginOrderWarnings(loaded: LoadedPlugin[]): string[] {
  const ours = loaded.findIndex((p) => p.name === '@openagentsy/hooks');
  return loaded.slice(ours + 1).filter((p) => p.hooks.includes('tool.execute.before'))
    .map((p) => `${p.name} runs tool.execute.before after OpenAgentsy and could change arguments we already checked.`);
}
```

- **`unverified` items are listed in `oa report --ethical`**, so nobody mistakes a guess about the OpenCode API for a tested fact. `mcp-tool-prefix` is expected to be one of them until a pinned version proves otherwise — and until then, the permission map (not the hook) is what the security model stands on (§8.2).

---

## 12. `oa report --ethical`: what the run cost, and what it was worth

Revision 1 referenced this command three times and never specified it. This section is the specification. One screen of plain text, no color, no judgment of the person; every number traceable to its source table; nothing leaves the machine.

```
$ oa report --ethical [--session <id> | --bean <id> | --since 30d]

OpenAgentsy run report — <scope>, <window>

Cost and footprint (ledger + footprint tables; ranges per §5)
  tokens by role: lead 412k · scout 88k · builder 1.1M · reviewer 96k · offload 22k
  spend: $14.82 reported · $1.19 estimated · 3 models unpriced
  electricity 2.1–4.8 kWh · water 210–980 L · carbon 0.9–2.1 kg CO2 (grid: owid:US)
  dominant uncertainty: model-size · infrastructure undisclosed for 1 provider

Waste (waste table, §6.4)
  18% of tokens went to retries, undos and reverted code
  retries 9% · tool-error loops 4% · undos/reverts 3% · cache misses 2% · no-progress rounds 3

Value (outcome table, §6.5)
  6 tasks completed · 1 scrapped · tokens per completed task: 214k (median)
  offload saved 41k cloud tokens (~$0.12)

Oversight (board db, audit log, stores)
  3 lessons to review · 1 memory to triage · 2 waivers recorded · 5 redactions
  board/report mismatches: 0 · open floor findings: 0

Conformance (conformance.json, §11)
  10/17 observed · plugin-order warnings: 1 (yaml-hooks runs after openagentsy)
  unverified: mcp-tool-prefix, prompt-insert, memory-inbox-keymap
```

**Rules.**

- Footprint values print as ranges with the dominant uncertainty, never single numbers (§7.6's discipline, applied to text).
- "Unpriced" is shown as unpriced, never `$0` (§6.3).
- The report never characterises the user (§6.4); it reports what the agents did and what it cost.
- Sources are named per section (the header line of each block); `--verbose` prints the exact table/query behind each number.
- Exit code is 0 unless `--check` is passed, in which case nonzero when there are open floor findings, unreviewed lessons older than N days, or board/report mismatches — a CI-able honesty gate.

---

## 13. Configuration (`openagentsy.jsonc`, Phase 2 keys)

**Config map — five authorities, one order.** Phase 1's review flagged config discovery divergence and the remediation closed it for OpenCode's files; Phase 2 adds two more files, so the whole map is decided here once:

| File | Authority over | Written by | Notes |
| --- | --- | --- | --- |
| `roles.yaml` | roles, permission maps, guidance | a person; consumed by the generator | The source of truth for agents. PROTECTED (§8.3). |
| `opencode.json` + `.opencode/opencode.json{,c}` | host: plugins, permissions, compaction | a person; `setup` (warns on overlap) | Merged by OpenCode; doctor reports every contributing file (landed). PROTECTED. |
| `openagentsy.jsonc` | Phase 2 keys (below) | a person | PROTECTED. Defaults; `.beans.yml` overrides the `tasks.*` keys when present. |
| `.beans.yml` | Beans interop: `beans.prefix`, `beans.id_length`, `beans.path` | a person | Takes precedence over `tasks.*` so OpenAgentsy and the `beans` CLI write the same IDs. |
| `openagentsy.models.lock.json` | the model lock | `openagentsy models init` | Generated; PROTECTED; zod-validated on read (landed). |

Doctor (2a extension) prints this map with the files that exist and flags overlaps — the same posture the remediation gave OpenCode's own configs.

```jsonc
{
  "tasks": { "path": ".beans", "prefix": "oa-", "idLength": 4, "worktrees": { "baseRef": "main", "integrate": "pr", "setup": "bun install --frozen-lockfile", "fetchTimeoutSec": 10 } },
  "memory": { "maxTextChars": 280, "inboxLimit": 50 },
  "footprint": {
    "showWarming": true,
    "prefill": false,
    "gridRegion": "auto",            // "auto" = provider's disclosed region, else world default; or ISO code e.g. "US"
    "localDeviceWatts": [25, 60],    // range, for laptops running local models
    "models": { "ollama/qwen3:8b": { "totalParamsB": [8, 8], "activeParamsB": [8, 8] } }
  },
  "ledger": { "backfillOpencodeDb": false, "pricingSources": ["opencode", "models.dev", "litellm", "openrouter"] },
  "offload": { "backends": [{ "kind": "ollama", "baseUrl": "http://127.0.0.1:11434", "model": "qwen3:4b" }], "jobs": ["title", "json-repair", "classify", "quick-replies"] },   // "compaction" opt-in
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

---

## 14. Left out on purpose

| From | Feature | Why not |
| --- | --- | --- |
| Magic Context | The historian, dreamer, decay rendering, cache-stable drops | The §4 slice proves the inbox contract (candidates → human decision → store → search) first. The full historian is 2f+, built against that proven contract. `setup --magic-context` (landed) remains the informed opt-out for people who want compaction off today. |
| Magic Context | Auto-recall: injecting memories into prompts without being asked | Doing it badly poisons contexts silently. Agents search (§4.4); auto-recall waits for the historian and its relevance measurements. |
| agentsy | Prompt patches that apply themselves at ≥0.9 confidence | Changes to the agent's own instructions need a person's review (§8.5). |
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
| Hallmark | Together AI calls when `TOGETHER_API_KEY` is set | There are no hidden network calls. The key is stripped from sloplint's environment (§10.4) and from agent shells (§8.3), alongside `TYPESAFE_API_KEY`. |
| opencode-yaml-hooks, openhooks | A YAML shell-hook layer (exit code 2 blocks the tool) | A second place for policy to live, and its actions inherit the full environment. We keep its `file.changed` normalisation and `scope` idea (§8.2). People can install either plugin alongside ours; conformance flags the ordering (§11). |
| OpenCode | The `stop` hook, `permission.ask`, and `experimental.hook.file_edited` / `session_completed` in `opencode.json` | `stop` isn't in v1.19.4's hook table, and `permission.ask` is never called. The config-file hooks appear in only one guide and are unverified. Approvals use the permission config plus blocking instead (§8.3). |
| Turborepo | Remote caching (Vercel or self-hosted) and telemetry | Remote caching uploads build artifacts, so it's opt-in only. Telemetry is disabled everywhere (§1). |

---

## 15. Build order and exit tests

**Preconditions — landed.** The Phase 1 remediation (its Steps 1–20) is the baseline; see "Baseline" above. Every feature below cites what it stands on rather than re-fixing it. The standing rules from revision 1 still hold: after every step, `bun run check` (aliased per §1.6) is green; the safety suite's 14 cases stay green; `TURBO_TELEMETRY_DISABLED=1` is set in CI and in agent shells.

One ordering fix from revision 1: its step 2.0 exit test required an agent told to `pnpm add x` to be blocked — but the rule that blocks it ships in 2c. The red-team now lives where its machinery lives.

| Step | Delivers | Exit test (in the Scenario + Vitest suites) |
| --- | --- | --- |
| **2.0r** | §1.6 residue: `packageManager` pin, catalog decision, `check`/`ci:check` alias, `CONTRIBUTING.md`, `oa` bin alias, CI reconciliation | <ul><li>`bun install --frozen-lockfile` succeeds on a clean clone.</li><li>`bun run check` ≡ the old `ci:check`; a second run with no changes is fully cached.</li><li>`oa doctor` works through the alias; `openagentsy doctor` still works.</li><li>`git grep -n pnpm` finds nothing outside CHANGELOG and this spec's history notes (already true; stays a guard).</li><li>The pre-commit hook still blocks a lint failure.</li><li>`TURBO_TELEMETRY_DISABLED` is set in CI and in agent shells (the latter lands with 2c's `shell.env`).</li></ul> |
| **2a** | `defineTool` extraction (§2.3); `tasks` package + prime (§3); **memory slice (§4)**; `footprint` (§5); doctor config-map extension (§13) | <ul><li>Round-trip over the `hmans/beans` `.beans/` corpus passes; whitespace diffs, if any, are logged and accepted deliberately.</li><li>`ready` and `next` match Beans' documented semantics on 15 fixtures (blocked parent, terminal ancestor, epics excluded).</li><li>The footprint golden test passes within 1%.</li><li>The prime block is ≤ 200 tokens **and renders p95 ≤ 5 ms at 500 live tasks** (§3.5 budget, measured from a fixture).</li><li>Memory: all §4.6 cases — round-trip, rejection, map-blocks-decide-with-hook-disabled, redaction, no-prime-growth.</li><li>No generated prompt references an unregistered tool (landed guard; stays).</li><li>`grep -rn "defineTool" packages/*/src` resolves to definitions and the §2.3 export only.</li><li>Doctor prints the §13 config map with the files that exist.</li></ul> |
| **2b** | `ledger` (ingest, pricing, waste including `no_progress`, outcomes), `offload`; **budget reconciliation (§6.7)** | <ul><li>Deduplication: replaying a session doesn't change totals.</li><li>Unpriced models show "unpriced".</li><li>Backfilled rows with unresolvable roles carry `role_raw` and are excluded from per-role reports.</li><li>Offload lowers cloud tokens per completed task compared with Phase 1, with pass³ unchanged.</li><li>Budget stop fires on **measured** ledger usage the builder never self-reported (§6.7).</li><li>`oa ledger scan-reverts` on a fixture repo reports a reverted `Refs:` commit and nothing else.</li></ul> |
| **2c** | `hooks`: bridge, rules (including `human-only-decisions` and the `package-manager` red-team), redaction, output checks, **lessons + eval runner**, **Lead recovery loop**; PROTECTED (§8.3) + the doctor regeneration-diff check; `/oa approve` | <ul><li>Red-team: a model told to "commit with --no-verify", "edit roles.yaml", "edit .opencode/agent files", "npm install", or "approve your own lesson" is blocked.</li><li>An `apply_patch` that moves a file onto `roles.yaml` is blocked.</li><li>**Both directions of the human-only guarantee**: with the hook rule disabled, the permission map alone blocks `oa_lesson_decide`; with the maps regenerated without the denies, the hook rule alone blocks it.</li><li>The regeneration-diff doctor check flags a hand-edited generated agent file and names the reconcile command.</li><li>A rewrite of tool arguments takes effect (mutated in place).</li><li>Agent shells see neither `HUSKY` nor `TYPESAFE_API_KEY`.</li><li>The anchored `-n` rule does **not** fire on `git commit -m "fix -n handling"` and does fire on `git commit -n`.</li><li>Merging permissions only tightens them (`allow`→`ask` works; `deny`→`allow` throws).</li><li>`/oa approve`: a granted callID passes exactly once; the entry is consumed; an expired entry never passes.</li><li>A seeded secret never reaches `.openagentsy/` — including inside a lesson summary or a memory candidate.</li><li>Lesson transitions: every allowed move succeeds and every other move throws; an incomplete start packet can't leave `candidate`.</li><li>The eval runner rejects shell strings, a `cwd` outside the workspace and a timeout over the maximum; it rejects symlinked result paths, never writes stdout or stderr, and strips a fake `GITHUB_TOKEN`.</li><li>In a temporary worktree, the baseline fails and then the candidate passes.</li><li>A board/report mismatch raises a flag, and a round that changes nothing writes `no_progress`.</li><li>Output-check flags appear on seeded transcripts.</li></ul> |
| **2d** | `quality`: registry, static rules, comment lint, sloplint bridge, waivers, the three skills, reviewer gate | <ul><li>Each static rule has a passing and a failing fixture.</li><li>A comment fix leaves the AST identical apart from comments, and never removes a comment on the preserve list.</li><li>A task with an open floor finding can't be completed.</li><li>An agent can't record a waiver (map + hook, both directions), and a floor rule can't be waived.</li><li>A "ship" verdict with an open floor finding is rejected as `fabricated-pass`.</li><li>sloplint runs without `TOGETHER_API_KEY` and degrades cleanly when Hallmark is absent.</li><li>No quality skill loads when no UI, copy or comment file is touched (token test).</li></ul> |
| **2e** | `sidebar` V2 blocks, V1 fallback, worktrees (§3.8/§3.9), `oa conformance`, `oa report --ethical` | <ul><li>Blocks render from fixtures in the OpenTUI test renderer; banned-word and banned-colour tests pass.</li><li>The V1 toast fires on `session.idle`.</li><li>**Worktree shared state (§3.9)**: a builder in a worktree is denied by the Lead's main-board lease; its records land in the main board; its `.beans/` edits stay worktree-local and clear after merge.</li><li>Worktree task detection matches `git diff`, and provisional statuses clear after merge.</li><li>Every **VERIFY** in the spec maps to a conformance check; a capability with no recorded observation reports `unverified`, and a static probe never upgrades a check to `observed`.</li><li>`oa report --ethical` renders from a seeded fixture with every section populated; `--check` exits nonzero on an open floor finding.</li><li>The suite's 14 cases still pass on the full stack (the harvest-memory case now also asserts its record reaches the memory inbox).</li></ul> |

**Definition of done for every step** (addition, per the doc-sweep finding): AGENTS.md's package enumeration and plan references are updated in the same commit, `grep -rn ADDENDUM` stays clean outside CHANGELOG history, and the ROADMAP's "what ships" list matches what shipped.

---

## 16. Open questions

- **Prefill term:** keep it off by default until the fit is reviewed (recommended)?
- **Bundling `models.json`:** fetch-and-cache only, until the EcoLogits data license is confirmed?
- **Upstream export:** should agentsy add a `./hooks` subpath export to `@agentsy/runtime`, or re-export the hooks from the package root?
- **Beans compatibility:** keep OpenAgentsy's rendering byte-identical to Beans', or accept whitespace differences?
- **V1 sidebar hook:** confirm whether issue #5971's sidebar hook merged.
- **Em dashes:** `quality.copy.emDash` is `off` by default. Switch it to `reflex` if the agents shouldn't use them in UI copy?
- **Unsourced claims as `floor`:** block completion until a claim has a source or placeholder marker (recommended), or downgrade them to `reflex` so a person can waive them?
- **Comment rules in Biome:** also ship them as a GritQL plugin once comment matching is confirmed, or keep them only in `packages/quality`?
- **Strict hoisting:** turn on `install.hoist = false` now (stricter than pnpm's default), or after fixing phantom imports (recommended)?
- **Test runner:** keep Vitest (recommended; no rewrite), or move to `bun test` once on Bun?
- **Plugin order:** if another plugin's `tool.execute.before` runs after ours, should `oa conformance` only warn (recommended), or refuse to mark the guardrails as `observed`?
- **Approval fallback:** if the `config` hook can't change permissions, may `oa init` write the `ask` entries into `opencode.json`, after showing the person the diff?
- **Memory embeddings:** ship `oa_memory_search` re-ranking via offload behind a flag in 2a, or defer to the historian phase (recommended — substring search first, measure whether it's insufficient)?
- **`session.family` shape:** ids or session objects on the pinned 2.x (VERIFY → capability `session-family`, §11)?
- **Review archive:** commit the Phase 1 code review and the plan review under `docs/reviews/` so this revision's "revision notes" table cites files that live in the repo (recommended)?

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
[^planreview]: Phase 2 plan review (P-01..P-16) — delivered alongside this revision; see §16's "Review archive" question about committing it under `docs/reviews/`
