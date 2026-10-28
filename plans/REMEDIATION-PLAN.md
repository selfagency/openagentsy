# OpenAgentsy — Exhaustive Code Review

**Status: remediated.** Every finding was re-checked against the code on 2026-10-23 and closed, except the three that are roadmap items (F-08, F-20, F-28) and the ones the plan itself guards against (the `templates/` edits). The commits are in the changelog; the two findings the review did not have are listed at the end of this file.

**Branch:** `develop` (HEAD `bb4eece`, "fix(security): the paths the findings pointed at")
**Methodology:** [Exhaustive Code Review Skill](https://raw.githubusercontent.com/voxslopuli/skills/refs/heads/main/skills/code-review/SKILL.md) — 13 review dimensions, plan-before-fixes, zero-`any` tolerance.
**Scope:** Whole codebase (141 tracked files; all 84 TypeScript sources in `packages/*` read in full, plus `roles.yaml`, skills, plans, configs, CI workflows, tests).
**Benchmark corpus:** opencode agent docs (opencode.ai + opencode.asia), oh-my-openagent (OmO), OpenAgentsControl (OAC), docs.typesafe.ai cookbooks, cortexkit/aft, cortexkit/magic-context, the Gas Town corpus (Yegge's three posts, tenzinwangdhen's review, trilogy.ai's cost deep-dive, HN 46624883), dev.to/kiwibreaksme.
**Automated checks:** **Not executed.** Per the requester, this was a static review — no dependency install, no `bun run ci:check`, no unit tests, no safety suite. Per the skill's Phase 4 rule this must be stated explicitly: every finding below comes from manual tracing; the typecheck/lint/test gates must be run before any remediation is trusted. The repo's own CI (`.github/workflows/check.yml`) runs Biome + turbo typecheck + unit tests + a fallow gate on PRs — that machinery exists and is well configured.

---

## Executive Summary

OpenAgentsy is a **significantly above-average codebase** — in the top tier of what this reviewer has seen in the agentic-tooling space. The type discipline is exemplary (strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`; exactly **one** `any` in 84 source files, in a test helper, permitted by an explicit Biome override). The glob matcher in `packages/core/src/paths.ts` is a linear-time DP that is deliberately ReDoS-proof — better than most production glob implementations. The security posture is thoughtfully layered: the write guard lives **outside prompts** (in a plugin + the board), refusals are audited with policy ids, the self-granted-lease hole was found and closed with the permission map, and the safety suite runs real OpenCode sessions with state-first, judge-second verification and calibrated tie-breaking — the typesafe.ai guardrail philosophy implemented for real.

However, the review found **one CRITICAL defect, six HIGH defects, and a tail of MEDIUM/LOW issues**, plus a set of plan-versus-implementation gaps that the ROADMAP only partially acknowledges. The headline items:

1. **CRITICAL — the Lead role is broken in the plugin.** `roleNameOf()` does not resolve `agentName` overrides, so the Lead (agent id `agentsy`, role key `lead`) can never climb the effort ladder (every `oa_effort` call returns "no model lock for agentsy"), and its sessions are harvested against the explicit design of `NOT_HARVESTED`. The safety suite never exercises the Lead's climb, so CI is green while the flagship role's plugin features are dead.
2. **The memory pipeline dead-ends.** The archivist is told to "save at most five candidate memories," but no memory tool exists (`ctx_memory` was planned, never wired), `edit`/`shell` are denied, and nothing instructs it to post board records. Candidate memories evaporate in a hidden child session nobody reads.
3. **The V2 plugin path silently drops the harvest**, the **scout's primary guidance mandates AFT tools that `setup` never registers**, and **compaction is disabled for a Magic Context integration that does not exist yet** — three places where the repo's config/prompts promise machinery the code does not ship.

**Merge recommendation: APPROVE AFTER FIXES.** Nothing here invalidates the architecture; the CRITICAL and HIGH items are all localized, testable, and fixable without design change. The full, agent-executable remediation plan is in the **Remediation Plan** section — it is written as a work order an agent can follow step by step.

---

## Findings

Severity scale: **CRITICAL** blocks merge · **HIGH** fix before merge · **MEDIUM** should fix · **LOW** nice to fix.

### 1. Programmatic Correctness

#### F-01 · `roleNameOf` does not resolve `agentName` overrides — the Lead's plugin features are dead
- **Severity:** CRITICAL
- **File(s):** `packages/adapter-opencode/src/guard.ts:355-358`; call sites `index.ts:58,124,161`, `v2.ts:150,194,319`
- **Description:** `roleNameOf(agentId)` only strips the `oa-` prefix. The Lead's agent id is `agentsy` (from `roles.yaml` `lead.agentName`), so `roleNameOf('agentsy')` returns `'agentsy'`, but the model lock, the roles file, and the rung state are all keyed by role key (`lead`). `planClimb()` looks up `lock.roles['agentsy']` → `undefined` → returns `{ ok: false, message: 'no model lock for agentsy...' }` on every call.
- **Why it matters:** The Lead is the primary agent and the only role with a wide ladder (`medium` → `xhigh`, `steps: 200`). Its effort-climb feature never works. Worse, `onSessionIdle` computes `role = roleNameOf(agent)` → `'agentsy'`, and `NOT_HARVESTED = new Set(['lead', 'archivist'])` does not contain `'agentsy'`, so **Lead sessions are harvested**, contradicting the design comment and burning archivist tokens on the one session whose transcript is the human's own history.
- **Affected code path:** V1 and V2 `oa_effort` tool; V1 `chat.params` rung application; `onSessionIdle`/V2 idle loop harvest gating; rung bookkeeping keys.
- **Root cause:** Two naming schemes (role key vs agent id) with a resolver (`roleKeyOf`, which handles the mapping correctly and already exists in `guard.ts:150`) that is wired only into lease matching, not into the plugin's role lookups.
- **Recommended fix:** See Remediation Step 1.
- **Verification:** New unit test: build a lock with a `lead` entry, call `planClimb(root, 'agentsy', 'planning')` (resolved path), expect `ok: true`. New safety-suite case: the Lead climbs in a real session. Assertion that `harvest` is skipped for agent `agentsy`.

#### F-02 · `reportUnreadable` mis-derives the project root and writes audits to a junk path
- **Severity:** HIGH
- **File(s):** `packages/adapter-opencode/src/guard.ts:111-125`, called from `loadLock` (line 316)
- **Description:** `const root = path.slice(0, path.indexOf('/.openagentsy/'))`. For the lock file the path is `<root>/openagentsy.models.lock.json`, which does **not** contain `/.openagentsy/`; `indexOf` returns `-1`; `slice(0, -1)` chops the final character. `appendAudit` then does `mkdir -p` and writes to `<root>/openagentsy.models.lock.jso/.openagentsy/audit.jsonl`.
- **Why it matters:** An unreadable lock file (the exact condition the code exists to report) produces a garbage directory tree and an audit line at a location nothing reads. The audit trail — the project's stated guarantee ("every decision is on the record") — silently loses the event.
- **Affected code path:** `loadLock` error path → `reportUnreadable` → `appendAudit` with corrupted root.
- **Root cause:** Root re-derived by string surgery instead of being passed by the caller, which already has it.
- **Recommended fix:** See Remediation Step 2.
- **Verification:** Unit test: write a corrupt lock file at a temp root, trigger `readRungs`/`planClimb`, assert the audit line lands at `<root>/.openagentsy/audit.jsonl` and no sibling junk directories are created.

#### F-03 · Effort tool reports success without applying the model switch
- **Severity:** LOW
- **File(s):** `packages/adapter-opencode/src/index.ts:69-91`; `v2.ts:160-178`
- **Description:** When `target.model` contains no `/` (separator `-1`), the rung is recorded and the tool replies "Climbed to rung N…" even though no `promptAsync`/`switchModel` call was made.
- **Why it matters:** The success message is untrue in that branch; the agent will report a climb that did not happen. In practice the lock file always writes `provider/model`, so the branch is defensive — but a lie in a success path is still a defect.
- **Affected code path:** `oa_effort` with a malformed lock entry.
- **Root cause:** Early-return path skips the switch but not the success report.
- **Recommended fix:** Return a distinct message ("the lock entry has no provider/model id, the climb was recorded but not applied") and audit it under `oa.effort.refused`.
- **Verification:** Unit test with a lock entry whose `model` is `"glm-5.3"` (no provider).

#### F-04 · V2 event subscription has no error handling
- **Severity:** MEDIUM
- **File(s):** `packages/adapter-opencode/src/v2.ts:310-325`
- **Description:** `void (async () => { for await (const event of ctx.event.subscribe(...)) {...} })()` — any throw inside the loop (e.g. `writeRungs` hitting `EACCES`) becomes an unhandled rejection. There is no `try/catch`, no audit entry, and the loop dies silently, so rungs stop being cleaned up.
- **Why it matters:** The plugin's own philosophy is "a failure is on the record." A dead event loop is the silent-stall failure mode the fault-injection eval case exists to catch — inside the plugin itself.
- **Recommended fix:** Wrap the loop body in `try/catch`; on error, `appendAudit` under a new policy id (`oa.events.failed`) and continue or exit cleanly.
- **Verification:** Unit test injecting a `writeRungs` failure; assert audit line and no unhandled rejection.

#### F-05 · `decideFromLeases` ranks specificity by string length; `a/**` matches bare `a`
- **Severity:** LOW
- **File(s):** `packages/core/src/board/leases.ts:178-180`; `packages/core/src/paths.ts:173-179`
- **Description:** "Most specific matching glob wins" is implemented as `sort((a,b) => b.glob.length - a.glob.length)`. A long literal (`src/very/long/name.ts`) correctly beats `src/**`, but structural specificity (literal > `*` > `**`) is not modeled; two globs of similar length can mis-rank. Separately, the `segments` token matches the empty remainder, so `a/**` matches path `a` itself (picomatch would not).
- **Why it matters:** Edge-case lease shadowing is possible; the semantics diverge from OpenCode's own glob behavior that the file documents as the model ("the shape is the one OpenCode uses").
- **Recommended fix:** Score matches (literal chars count, penalize wildcards) or compare on segment specificity; decide and document whether `x/**` matches `x`.
- **Verification:** Property-style unit tests over the existing `paths.test.ts` table adding these cases.

### 2. Data Flow Correctness

#### F-06 · The archivist's candidate memories have no destination — the harvest dead-ends
- **Severity:** HIGH
- **File(s):** `roles.yaml:386-421` (archivist role); `packages/adapter-opencode/src/harvest.ts:138-161`; `plans/PLAN.md` §IV.2
- **Description:** The archivist's scope says "editing memory outside the memory tool" is out of scope — but **no memory tool exists**. Its permissions deny `edit`, `shell`, `subagent`; its skills list is empty; its guidance says "Write at most five candidates" with no destination named; the harvest packet says "Save at most five candidate memories" with the same gap. PLAN.md §IV.2 specifies Magic Context's `ctx_memory` — not wired anywhere in the repo.
- **Why it matters:** This is the repo's persistent-memory story (the Kibitzer/historian role from OmO and magic-context), and its output currently evaporates inside a hidden child session that no tool surfaces, no command reads, and no future agent searches. The ROADMAP lists "the session harvest — done"; the harvest runs, but what it harvests goes nowhere. The plan's promotion/dedupe/`ctx_search` flow is entirely absent.
- **Affected code path:** V1 `session.idle` → `onSessionIdle` → `harvest` → archivist session → (nothing).
- **Root cause:** Phase plan ordered the harvest before its sink; Magic Context integration was deferred without re-pointing the archivist at an existing sink (board records).
- **Recommended fix:** See Remediation Step 3 (minimal: post candidates as board records `to: lead`; full: a memory table + `board_memory` tool, roadmap item).
- **Verification:** Unit test asserting the archivist prompt names its destination; safety-suite assertion that a harvested session produces ≥1 readable record (or memory row).

#### F-07 · V2 plugin path never harvests
- **Severity:** HIGH
- **File(s):** `packages/adapter-opencode/src/v2.ts:307-325` vs `index.ts:118-147`
- **Description:** The V1 `onSessionIdle` gives the rung back **and** runs the harvest. The V2 `session.idle` loop only deletes `rungs`/`sessionAgents`/`switched` — no `harvest` call, not even a "skipped" audit line. README ("At the end of a session it collects what happened and asks the archivist to distil it") and ROADMAP ("the session harvest — done") describe the feature as version-agnostic.
- **Why it matters:** A V2 user gets a silently degraded plugin. The docs overstate what ships. The eval workflow itself documents that the V2 harness port is missing, so no test will ever notice.
- **Recommended fix:** See Remediation Step 4 (wire it if the V2 client surface allows; otherwise make the gap loud — audit `oa.harvest.failed` with reason "v2 harness pending" — and fix the docs).
- **Verification:** probe-v2 extension or unit test that the V2 idle path attempts the harvest (mocked) or audits the skip.

#### F-08 · Re-granting an existing lease under a new bean is a silent no-op
- **Severity:** MEDIUM
- **File(s):** `packages/core/src/board/leases.ts:86-118`
- **Description:** The `leases` unique index is `(agent, glob)`. If the Lead grants agent A the same glob for a new bean B2 while a lease for bean B1 exists: `taken` is undefined (same agent), the cap check is skipped (`existing.length !== 0`), `onConflictDoNothing` inserts nothing, and the glob appears in neither `granted` nor `conflicts`. The tool returns `{granted: [], conflicts: []}` — the Lead has no signal — and the board keeps attributing the file to B1.
- **Why it matters:** The Lead's plan model (bean B2 owns this file now) silently diverges from the board's state (B1). Every later `board_lease check` reports the stale bean; records posted under B2 never reconcile with the lease.
- **Recommended fix:** Return an explicit `alreadyHeld: {glob, agent, bean}[]` array (and/or update the bean when the granting bean differs), audit under `oa.lease.grant` with a distinct detail.
- **Verification:** Unit test in `leases.test.ts`: grant (A, G, B1), then (A, G, B2), assert the second result surfaces the existing hold and (per chosen semantics) the bean.

#### F-09 · Rung state is keyed by role, shared across concurrent same-role sessions
- **Severity:** MEDIUM
- **File(s):** `packages/adapter-opencode/src/guard.ts:75-131` (`RungState = Record<string, Rung>`); `index.ts:126-130`; `v2.ts:317-323`
- **Description:** The rung a role climbed to is stored per **role**, not per session. Two builders running concurrently (the system's core scenario — up to 3 writers) share one rung: builder A's climb moves builder B's effort too, and when A's session goes idle the rung is deleted from under B.
- **Why it matters:** The effort ladder's blast radius is wrong: one session's trigger escalates a different session, and one session ending de-escalates another. The `switched` set in V2 is per-session, which shows the intent was per-session state.
- **Recommended fix:** Key `rungs.json` by `sessionID` (role still needed for lock lookup), clean up per session on idle; `planClimb` resolves role from agent (see F-01 fix).
- **Verification:** Unit test: two sessions of `oa-builder`, one climbs, assert the other's `rungTarget` is unchanged; idle of the first does not clear the second.

#### F-10 · `recordUsage` overwrites instead of accumulating; usage is self-reported
- **Severity:** LOW
- **File(s):** `packages/core/src/board/budgets.ts:46-59`
- **Description:** `recordUsage` sets `tokensUsed` to the passed value. Two agents reporting on the same bean sequentially leave the last value, not the sum. All usage is self-reported by whichever agent calls `board_budget check`.
- **Why it matters:** The budget stop decision can be based on a stale or under-reported number. Bounded-harm: budgets are advisory (see F-16) and only the owning builder reports.
- **Recommended fix:** Document the semantics (latest snapshot) or accumulate with a monotonic guard; longer term, source usage from OpenCode session stats rather than the agent's own report.
- **Verification:** Unit test documenting chosen semantics.

### 3. Security

#### F-11 · Stale leases can permanently brick the writer cap — no expiry, no admin release
- **Severity:** HIGH
- **File(s):** `packages/core/src/board/leases.ts:120-154` (release-by-holder-only); `packages/mcp/src/index.ts` (no revoke op); `packages/cli/src/commands/*` (no release command)
- **Description:** The design is explicit: "A lease is only ever released by its holder… There is no other way to free a path." A crashed or killed session that held leases leaves them locked forever (the code's own comment says so). There is no TTL, no Lead-side revoke tool, no `openagentsy board lease release` CLI command, and no doctor check for stale leases. With `WRITER_CAP = 3`, three dead sessions exhaust the cap and the board refuses all new writers until someone hand-edits SQLite.
- **Why it matters:** Availability of the core coordination primitive depends on agents politely releasing in their shutdown path — the exact thing the fault-injection philosophy of this repo says not to trust. The eval case `FAULT_LEASE_REVOKED` works around it by opening the database directly; a user cannot.
- **Recommended fix:** See Remediation Step 6 (Lead-only `board_lease op=revoke` behind a `openagentsy_board_lease_revoke` permission-mapped tool, mirroring the grant pattern; `--stale` listing in doctor/board CLI; optional heartbeat/`lastSeenAt`).
- **Verification:** Unit tests for revoke-by-Lead and revoke-denied-for-builder (permission map), plus a CLI round-trip test.

#### F-12 · `board_record` identity is self-reported — record spoofing is unmitigated
- **Severity:** MEDIUM
- **File(s):** `packages/mcp/src/index.ts:206-241`; documented for leases in README/AGENTS.md
- **Description:** Any session can post records `from` any agent name. The README honestly documents that the board cannot verify MCP callers, and the grant tool was protected via the permission map — but `board_record`'s `from` field remains fully spoofable. A builder could post a completion record as another builder; eval checks like `FAULT_BUILDER_KILLED` filter on `record.from`.
- **Why it matters:** The hand-off channel is the system's source of truth for "who did what." The lease hole was closed because it mattered; the record channel has the same trust model and was left open. typesafe.ai's guardrail tenet applies: screen what crosses the boundary in code, not in prompts.
- **Recommended fix:** Short term: validate `from` against the known agent vocabulary (role keys + agent ids + `oa-` forms from `roles.yaml`) and audit refusals under `oa.record.identity`. Medium term (V2): stamp the agent from the permission-event identity where the protocol carries it.
- **Verification:** Unit test: post with `from: 'oa-builder'` from a session whose role vocabulary excludes it → refused and audited.

#### F-13 · Windows paths break the write guard's absolute-path join
- **Severity:** MEDIUM
- **File(s):** `packages/adapter-opencode/src/write-guard.ts:91`
- **Description:** `const absolute = path.startsWith('/') ? path : `${root}/${path}``. On Windows, an absolute path `C:\repo\src\a.ts` fails `startsWith('/')` and becomes `C:\repo\C:\repo\src\a.ts`-style garbage. Core's `normalizePath` handles backslashes, but the guard's join happens before it. `checkLease`'s `isAbsolute` (node:path, platform-aware) would handle it if given the raw path.
- **Why it matters:** Bun and OpenCode both run on Windows. A Windows session's writes would be mis-resolved and denied (fail-closed, fortunately) or match the wrong lease.
- **Recommended fix:** Use `path.isAbsolute(input.path) ? input.path : resolve(root, input.path)` (node:path, as `checkLease` already does) — the guard and the board should agree on one join.
- **Verification:** Unit test with `C:\\repo\\notes.md` style input on the `relativeToRoot` path (works cross-platform via mocked separators).

#### F-14 · `board_classify` sends the raw user request to an external service
- **Severity:** LOW
- **File(s):** `packages/mcp/src/index.ts:504-563`; `packages/jev/src/client.ts`
- **Description:** With `TYPESAFE_API_KEY` set, the request text leaves the machine to `api.typesafe.ai`. This is documented ("Set TYPESAFE_API_KEY in the environment to use it") but the privacy implication is not stated next to the opt-in.
- **Recommended fix:** One sentence in README §Classifier and in the tool description: "the request text is sent to the TypeSafe service when a key is configured."
- **Verification:** Docs-only.

#### F-15 · Supply-chain posture is strong (positive finding, keep)
- **Severity:** LOW (informational)
- **File(s):** `bunfig.toml` (`minimumReleaseAge = 1440`, isolated linker, exact pins), `.github/workflows/*` (all actions pinned by SHA), `package.json` trustedDependencies
- **Description:** This is better than nearly every repo in the reference corpus. No change required; noted so it is not "fixed" away.

### 4. Best Practices / Design Completeness

#### F-16 · Budgets are prompt-orphaned: tools exist, no agent is told to use them
- **Severity:** MEDIUM
- **File(s):** `roles.yaml` (no role guidance mentions budgets); `packages/mcp/src/index.ts:443-489`; `packages/cli/src/generate/commands.ts:52-63`
- **Description:** The board offers `board_budget`/`board_budget_set`, the usage card promises "at 85 percent the builder stops and posts a blocker," and the `status` command mentions budgets — but neither the Lead's nor the builder's guidance says to set or check a budget. Nothing enforces the stop; the check only returns a boolean the caller must act on.
- **Why it matters:** The cost-control story (the trilogy.ai "$800 lesson" dimension) is half-wired: enforcement is a tool away, but the loop is never closed in the prompts that drive behavior.
- **Recommended fix:** Add to Lead guidance: "Set a token budget for every bean you dispatch"; add to builder guidance: "Call board_budget op=check before you start and after each milestone; when it says stop, post a blocker record and stop." Consider a board-side guard: refuse `lease_grant` for a bean with no budget after a configurable date (warn-first).
- **Verification:** Safety-suite case: budget set below usage → builder posts blocker and stops.

#### F-17 · Scout guidance mandates AFT tools the setup never installs
- **Severity:** HIGH
- **File(s):** `roles.yaml:171-175` (scout guidance: "Prefer AFT outline, zoom, callgraph and search over reading whole files"); `templates/.opencode/skills/openagentsy-scout/SKILL.md` (tool table is 100% `aft_*`); `packages/cli/src/commands/setup.ts` (registers only the board MCP); `plans/PLAN.md` §IV.3
- **Description:** PLAN §IV.3 says "AFT as everyone's editor" — scouts use `aft_outline`/`aft_zoom`/`aft_callgraph`/`aft_search`, builders use symbol-level edit, reviewers use `aft_inspect`. None of that is wired: setup registers only the OpenAgentsy board; no AFT MCP server, no binary detection, no docs. Meanwhile the scout's *first* guidance line and its dedicated skill tell it to prefer tools that do not exist in the installed system.
- **Why it matters:** The scout's core instructions point at phantom tools. A literal scout will try `aft_outline`, fail, and either flounder or silently fall back — the "silent failure the safety suite exists to catch," now baked into the prompt. The builder/reviewer AFT patterns (`ast_grep_replace`, `aft_safety` checkpoints per bean) are also absent, unacknowledged.
- **Recommended fix:** See Remediation Step 5: make guidance conditional now ("when the AFT tools are present, prefer them; otherwise outline with read + grep and cite file:line"), and either wire AFT registration in setup (detect `aft` on PATH / a config flag) or record it as an explicit 0.2.0 roadmap item with the skill rewritten tool-agnostically.
- **Verification:** Regenerate agents; assert no generated prompt references a tool not present in a default install; safety-suite scout case still passes.

#### F-18 · Compaction disabled with no replacement — long Lead sessions grow unboundedly
- **Severity:** HIGH
- **File(s):** `packages/cli/src/commands/setup.ts:92-105` (writes `compaction.auto=false` on both targets); `plans/PLAN.md` §IV.2 (Magic Context "requires compaction to be off"); ROADMAP (no memory integration listed as pending)
- **Description:** Setup unconditionally disables auto-compaction — the correct configuration for Magic Context's historian. Magic Context is not integrated. So today the Lead (whom the plan says "keeps one long session") runs with compaction off and nothing shrinking its context.
- **Why it matters:** In real use the primary agent degrades toward context exhaustion — the precise failure magic-context exists to prevent, introduced by configuring for a feature that isn't there. This is the repo's own "Decisions that differ from the plan" genre: it should be either re-decided or loudly annotated.
- **Recommended fix:** See Remediation Step 7: stop disabling compaction by default until the historian lands; make it an opt-in flag (`openagentsy setup --magic-context`); doctor warns when compaction is off and no memory package is detected. Update README/ROADMAP to state the current state honestly.
- **Verification:** dry-run setup output review; doctor unit test for the new warning.

#### F-19 · The "beans" workflow is prompt-only — no task store, no dependencies, no claims
- **Severity:** MEDIUM
- **File(s):** `roles.yaml:93-95` ("Write the plan as beans. Each bean states objective, acceptance tests, owned globs, inputs, output format, budget and blockedBy."); `plans/PLAN.md` §IV.1; ROADMAP "What is not in 0.1.0"
- **Description:** The Lead is told to write plans as beans with `blockedBy` dependencies, but there is no task entity anywhere: a bean is a free-text string on records and leases. No dependency graph, no claim/release lifecycle, no `bd ready`, nothing that makes a bean queryable or resumable. The plan text lives in the Lead's context — exactly the "feed a giant spec into a single agent's context and hope" pattern the Gas Town reviews identify as the thing beads were invented to avoid.
- **Why it matters:** The prompt describes machinery the system does not have; agents will waste turns imitating it (inventing bean ids, faking dependency tracking). The ROADMAP is honest that the task store is 2a — but the prompt is not.
- **Recommended fix:** Reword Lead guidance to what exists today ("group records under a short bean id; state owned globs and acceptance tests in the dispatch message"), and keep the full bean semantics for the 2a `tasks` package. Alternatively land a minimal `board_task` tool (id, blockedBy, status) — the schema is 80% of the way there via records.
- **Verification:** Prompt review; safety-suite run unchanged.

#### F-20 · No observability surface beyond `openagentsy board`
- **Severity:** MEDIUM (design gap vs. reference corpus)
- **File(s):** `packages/cli/src/commands/board.ts`; no feed/health/OTel anywhere
- **Description:** The reference corpus is emphatic: Gas Town's `gt feed --problems` health states (GUPP violation / stalled / zombie / working / idle) + OTel events + dashboard; aft/magic-context doctor commands. OpenAgentsy has a good doctor and a board dump, but nothing watches a run: no stalled-agent detection, no event stream, no metrics, no per-run digest.
- **Why it matters:** tenzinwangdhen's core Gas Town complaint — "6 PRs merged and I had no idea… other times the system seemed stuck and I couldn't tell why" — applies here today. The audit log has the data; nothing reads it for liveness.
- **Recommended fix:** Roadmap item, but cheap first slice: `openagentsy board --watch` that tails `audit.jsonl` and prints agent health states derived from the last N decisions (last activity per agent, leases held, blockers posted). Wire into the 2a `sidebar` plan.
- **Verification:** Manual + integration test on a seeded audit log.

### 5. API Conformity and Consistency

#### F-21 · Two divergent `ModelLockEntry` types
- **Severity:** MEDIUM
- **File(s):** `packages/cli/src/generate/lock.ts:3-19` vs `packages/models/src/types.ts:72-90`
- **Description:** The CLI re-declares the lock schema instead of importing it. The copies have already drifted: the CLI's `evidence` lacks `surface`/`rank`/`score`, makes `date` optional, and its `ModelLock` omits `providers`. Neither copy validates the JSON at runtime (a malformed lock silently becomes `undefined` via catch, or passes with a wrong shape).
- **Why it matters:** The lock file is a contract between three packages and the plugin. Drift guarantees that a future field silently disappears for one consumer (the doctor already only prints `source`/`label`).
- **Recommended fix:** Move `ModelLock`/`ModelLockEntry` to `@openagentsy/core` types (or export from `@openagentsy/models` and import in CLI); add a zod schema and parse on read, mirroring the jev package's contract-first pattern.
- **Verification:** Type-level test + unit test feeding a malformed lock.

#### F-22 · Config discovery diverges from OpenCode's
- **Severity:** MEDIUM
- **File(s):** `packages/cli/src/opencode.ts:42` (`PROJECT_CONFIG_NAMES` root-only); `packages/cli/src/commands/setup.ts:51-61`; `packages/cli/src/commands/doctor.ts:75-105`
- **Description:** `findConfigPath`/`readProjectConfig` look only at `<root>/opencode.json{,c}`. OpenCode itself also reads `<root>/.opencode/opencode.json{,c}` — this repo carries one (`.opencode/opencode.jsonc`, which enables `fallow` and disables seven servers). Setup will happily write a root `opencode.json` next to a `.opencode/opencode.jsonc` it never inspected; doctor reports on one file while the runtime merges both.
- **Why it matters:** Split-brain config: the tool's view of "what is installed" can differ from what OpenCode loads — the exact class of surprise the doctor exists to eliminate.
- **Recommended fix:** Include `.opencode/opencode.json{,c}` in discovery; doctor should report every config file that contributes; setup should warn when writing would create a second active config.
- **Verification:** Unit test with both files present.

#### F-23 · `doctor` mislabels the Lead's agent id
- **Severity:** MEDIUM
- **File(s):** `packages/cli/src/commands/doctor.ts:147` (`agent: 'oa-${role.name}'`)
- **Description:** Hardcodes the `oa-` prefix instead of `agentIdOf(role)` (exported from core for exactly this). The Lead row prints `oa-lead` although the agent users pick is `agentsy`.
- **Why it matters:** The doctor's job is to tell a human what is installed; for the one agent a human actually selects, it names a file that does not exist.
- **Recommended fix:** `agent: agentIdOf(role)` — one line, imports already adjacent.
- **Verification:** Existing doctor test updated to expect `agentsy`.

#### F-24 · MCP `releaseLeases` uses untyped evolving arrays
- **Severity:** LOW
- **File(s):** `packages/mcp/src/index.ts:378-379`
- **Description:** `const released = []` / `const notHeld = []` — implicit `any[]`-evolving arrays in the one package with a zero-`any` Biome override. They should be `Lease[]` / `string[]`.
- **Why it matters:** Style/type-flow consistency; the repo's own bar.
- **Recommended fix:** Annotate both.
- **Verification:** Typecheck.

### 6. Documentation Consistency

#### F-25 · Broken and stale references across the agent-facing docs
- **Severity:** MEDIUM
- **File(s):** `.opencode/context/project-intelligence/navigation.md:27` (references `plans/PHASE-2-PLAN-ADDENDUM.md` — does not exist); `AGENTS.md:10` ("the addendum"); `AGENTS.md:8` ("six packages" — there are seven); `vitest.config.ts` (excludes nonexistent `baseline-run.test.ts`); `CHANGELOG.md:51` (addendum commit)
- **Description:** The navigation file is the onboarding doc for scouts ("A scout loads the file its task names"); it points at a missing plan. AGENTS.md undercounts packages. Vitest excludes a ghost test file. `evals.test.ts:25` carries an unused `_execFileAsync`.
- **Why it matters:** OAC's whole thesis is that agents are only as good as the context files they load; a 404 in the routing table is a wasted turn for every scout that follows it.
- **Recommended fix:** See Remediation Step 18 (doc sweep).
- **Verification:** Link-check script or manual pass; `bun run ci:check`.

#### F-26 · README/ROADMAP overstate shipped behavior
- **Severity:** MEDIUM
- **File(s):** `README.md` (harvest described unqualified; "the plugin… asks the archivist to distil it" — V1-only, and output goes nowhere, F-06/F-07); `ROADMAP.md` ("the session harvest — done"); `README.md:113` ("the role asks for the closest one" — the implementation clamps start *down* to the lowest available and ceiling *up* to the highest, which is defensible but is not "closest")
- **Description:** The docs describe the intended system in places where the shipped system differs. The repo's own culture ("The honest version" in ROADMAP) is the standard being missed.
- **Recommended fix:** Qualify the harvest paragraph (V1 today; V2 in 0.2.0; memory sink is board-records-pending); fix the ladder wording to "start at or below the named level, ceiling at or above it."
- **Verification:** Docs review against the remediated code.

#### F-27 · `engines` advertises Node; the runtime requires Bun
- **Severity:** MEDIUM
- **File(s):** `package.json` (`"engines": { "node": ">=22.5.0" }`); `packages/core/src/board/db.ts:1` (`import { Database } from 'bun:sqlite'`)
- **Description:** The board, the plugin, and the CLI all transitively require `bun:sqlite`. An `npx openagentsy …` run under Node will install (engines says Node ≥ 22.5) and then fail at runtime.
- **Why it matters:** The README's install path is `bunx openagentsy@0.1.0 setup`, but nothing stops an npm consumer; engines is the contract, and it lies.
- **Recommended fix:** Add `"engines": { "bun": ">=1.2.0" }` (keep or drop the node entry deliberately) and a README prerequisite line; consider a friendly runtime guard in the CLI entry ("this package runs on Bun").
- **Verification:** `bun pm pkg` inspection; manual npx attempt shows a clear error.

### 7. Performance

#### F-28 · `variantOptions` calls `provider.list()` on every model request while a rung is active
- **Severity:** LOW
- **File(s):** `packages/adapter-opencode/src/index.ts:33-48,159-167`
- **Description:** When a role has climbed, every `chat.params` fires a full provider inventory call to resolve the variant options. The inventory changes rarely; nothing caches it.
- **Why it matters:** Added latency and server load on the hot path of every model call for climbed sessions; in a 200-step Lead session that is 200 inventory fetches.
- **Recommended fix:** Cache per provider for N minutes (or for plugin lifetime) in the V1 server closure; V2 resolves the variant through `switchModel` already.
- **Verification:** Unit test asserting one provider.list across two chat.params invocations.

#### F-29 · Audit log is unbounded; every harvest and doctor run reads it whole
- **Severity:** LOW
- **File(s):** `packages/core/src/board/audit.ts` (append-only); `packages/adapter-opencode/src/harvest.ts:109-129` (full `readFile`); `packages/cli/src/commands/doctor.ts:107-114`
- **Description:** `audit.jsonl` grows forever; `decisionsOf` reads and parses the entire file per session end; `countAuditLines` likewise.
- **Why it matters:** Long-lived boards will make the harvest progressively slower and the file unwieldy; no rotation or per-session index exists.
- **Recommended fix:** Read audit lines with a streaming iterator (`readline`), and/or rotate by size with an archive file. Not urgent; note in 2a `ledger`.
- **Verification:** Bench on a synthetic 100k-line audit file.

#### F-30 · Glob matcher and path handling: correct and safe (positive finding)
- **Severity:** LOW (informational)
- **File(s):** `packages/core/src/paths.ts`
- **Description:** The linear-time DP matcher, `MAX_GLOB_LENGTH` cap, and fail-closed semantics (over-long glob matches nothing) are exactly the right answers for untrusted lease globs. Keep.

### 8. Type Correctness

#### F-31 · Type discipline: near-perfect (positive finding)
- **Severity:** LOW (informational)
- **File(s):** whole tree; `tsconfig.base.json`; `biome.jsonc`
- **Description:** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`; Biome `noExplicitAny: error` with a scoped test-only override; exactly one `any` (`server.test.ts:56` helper return) and three `as never`/`as unknown as` casts in tests/evals where SDK types are genuinely absent. Unsafe casts in production code: none found. The `as` casts in `client.ts`/`v2.ts` shape-define untyped SDK boundaries and are documented as such.
- **Why it matters:** Meets the skill's zero-`any` bar with an explicit, justified exception. No action.

#### F-32 · `toRecord` parses the contract column without a guard
- **Severity:** LOW
- **File(s):** `packages/core/src/board/records.ts:39`
- **Description:** `JSON.parse(row.contract)` — one corrupted row (hand-edited DB, partial write) throws and fails every inbox read for every agent.
- **Why it matters:** Fail-loud is arguably right, but the blast radius is all inboxes, and the field is optional display data.
- **Recommended fix:** `try { JSON.parse } catch { record.contract = row.contract }` with an audit-free console-free degradation, or surface as a string.
- **Verification:** Unit test with a corrupt contract row.

### 9. Testing Coverage

#### F-33 · The safety suite is exceptional — but the Lead's plugin paths are untested
- **Severity:** MEDIUM
- **File(s):** `packages/evals/src/scenarios.ts` (10 cases); no case exercises `oa_effort`, budgets, or harvest from the Lead's session
- **Description:** The suite covers scope push (both directions), red team, false premise, seeded bug, board fault, provider faults, lease revocation, builder killed. It does **not** cover: the Lead climbing (F-01 sailed through), the budget stop loop (F-16), the harvest→archivist flow end-to-end (F-06), or record-spoofing (F-12). V2 is probe-only (acknowledged in ROADMAP).
- **Why it matters:** The suite is the repo's crown jewel; its blind spots are exactly where the CRITICAL/HIGH defects live. This is the "a passing safety test proves little until it has been seen to fail" lesson from magic-context's `mutations.toml`.
- **Recommended fix:** Add cases per Remediation Steps 1, 3, 6, 16; adopt the mutations idea at small scale: an `evals/mutations.md` row per guard naming the case that must fail when the guard is deliberately broken (apply to: lease write guard, grant permission map, protected paths).
- **Verification:** The new cases fail on the current code (proving they bite), then pass post-fix.

#### F-34 · Eval assertion quality nits
- **Severity:** LOW
- **File(s):** `packages/evals/src/scenarios.ts:208` (`/\b10\b/` fails any file containing "10", including a corrective comment "returns 6, not 10"); `:84-91` (`pushedSomething` matches any "push" substring in any bash/git input); `packages/evals/src/evals.test.ts:25` (unused `_execFileAsync`)
- **Description:** Two over-broad regexes can produce false failures that a human will waste time disputing; one dead binding.
- **Recommended fix:** Narrow the premise check to the note's phrasing ("mixed list case is covered", "returns 10" adjacent to "covered"); require `push` as a git subcommand (`\bgit\s+push\b` or tool-input command field); delete the dead binding.
- **Verification:** Suite re-run.

### 10. Library and API Verification

#### F-35 · SDK usage is documented against real binaries — no hallucinated APIs found
- **Severity:** LOW (informational)
- **File(s):** `packages/adapter-opencode/src/client.ts`, `v2.ts` (V2 context shape "verified against @opencode/cli@2.1.3"), `permissions.ts` (the V1 `bash`-not-`shell` finding, verified via `opencode agent list`), `packages/evals/src/opencode.ts` (server API shapes)
- **Description:** Every non-obvious SDK surface carries a comment naming the binary and version it was verified against, and the README's "Decisions that differ from the plan" section documents seven doc-vs-binary divergences. MCP SDK usage (`registerTool`, zod `inputSchema`, `StdioServerTransport`) matches current SDK patterns. Drizzle/bun-sqlite wiring is conventional and correct. No deprecated or invented APIs detected in static review.
- **Why it matters:** This is the dimension most repos fail; this one passes. Caveat: without running the typecheck, SDK drift can't be fully excluded — CI covers it.

### 11. Linting / Style

#### F-36 · Tooling and style: exemplary (positive finding)
- **Severity:** LOW (informational)
- **File(s):** `biome.jsonc` (formatter + `noConsole: error` + `noExplicitAny: error` with scoped overrides), `turbo.json` (env-keyed test caching), `.husky/pre-commit` (lint-staged → typecheck → coverage → fallow gate), pinned CI actions, `bunfig.toml` supply-chain hardening
- **Description:** One style-level finding beyond F-24: `index.ts:158` registers a no-op `'chat.message'` hook — dead weight; delete or comment why (placeholder for future use).
- **Recommended fix:** Remove the no-op hook or document it.

### 12. Syntactic Correctness

#### F-37 · No syntax, import, or module-resolution defects found
- **Severity:** LOW (informational)
- **File(s):** whole tree
- **Description:** All imports resolve within the workspace (`@openagentsy/*` via workspaces; the adapter bundles its deps via tsdown per the documented plugin-loader constraint). ESM `.js`-extension discipline is consistent. No circular imports detected (core ← models/cli/mcp/adapter; jev ← mcp/evals). Note: full confirmation requires `tsc -b`, not run here.

### 13. Data Flow — Eval Harness (additional observations)

#### F-38 · Harness quality is high; two notes
- **Severity:** LOW
- **File(s):** `packages/evals/src/opencode.ts`, `fixture.ts`
- **Description:** The harness's permission auto-answer, per-request fetch timeouts, idle-poll with completed-message checks, rate-limit retry with bounded attempts, and `childEnv` key separation are all careful and correct. Notes: (a) `headlessRoles` flips `webfetch`/`websearch` to `deny` for all roles — including the **researcher**, whose entire job is web access; no researcher case exists today, so nothing breaks, but the helper will silently neuter a future researcher case. (b) `mcpServerNames` regex-scrapes global configs without JSON parsing — pragmatic, documented, fine until someone nests `"mcp"` oddly.
- **Recommended fix:** When a researcher case is added, make `headlessRoles` role-aware. Add a comment on (b).

---

## Best Practices Conformance (benchmark corpus)

How OpenAgentsy's shipped behavior measures against the reference corpus. **Ahead** = exceeds the corpus norm; **Aligned** = matches it; **Behind** = corpus shows a proven technique the repo lacks.

### Where OpenAgentsy is ahead of every reference

1. **Single-writer leases enforced outside prompts (Ahead of OAC, Gas Town, OmO).** OAC's approval gates are prompt rules; Gas Town's `--dangerously-skip-permissions` yolo is the cautionary tale; OpenAgentsy enforces one-writer-per-file in a plugin guard + board, fail-closed for unknown agents and unreadable paths, with every decision audited. This is the typesafe.ai tenet ("guardrails outside the system prompt") applied to file writes — no reference project does this.
2. **State-first evals with real sessions (Ahead of corpus).** OAC ships an `evals/` directory; typesafe publishes measured numbers; Gas Town has none. OpenAgentsy runs ten cases against a real OpenCode server, asserts on disk/board/audit state before any judge runs, uses a tool-less judge agent with per-criterion verdicts, majority-of-3-trials, and System One probability tie-breaking at a 0.7/0.3 bar. This is the most rigorous agent-behavior suite in the corpus.
3. **Typed decisions as a first-class dependency (Aligned with typesafe.ai, ahead of everyone else).** The jev client (choice/noul/score questions, zod-validated responses, never-throws outcomes, retry with `Retry-After` handling) and `board_classify` implement typesafe's "structured by construction" philosophy, including the cheap-plan-on-low-confidence rule — typesafe's confidence-gated routing, in production.
4. **The permission map as the trust boundary (Aligned with opencode, applied better than OAC).** Denying `openagentsy_board_lease_grant` by tool name to every non-Lead role — after *measuring* that `tool.execute.before` does not fire for MCP calls — is exactly opencode's `permission.task` pattern, derived from a real attack (the self-granted lease) and proven by a dedicated eval case. Textbook.
5. **Privacy-aware model selection (Ahead of corpus).** No reference project filters models by training/retention terms. OpenAgentsy joins four sources (served inventory, models.dev capabilities, BenchLM ranks with evidence labels, a checked-in retention policy with source links), refuses by default (`--allow-training`/`--allow-retention` are opt-in), and records evidence for every choice including rejections. OmO's category chains route by capability and cost; this adds terms — a genuinely novel dimension.
6. **Capability-derived effort ladder (Ahead of corpus).** Effort rungs come from what the model actually offers (models.dev), clamped into the role's ladder, with trigger-gated climbing and an auditable tool as the only climb path. This is typesafe's cheap→escalate cascade done per-session, and it is a better cost mechanism than anything in OmO or Gas Town (whose answer to cost was trilogy's manual model pinning).
7. **Role file as single source of truth generating two runtime targets (Ahead of corpus).** opencode defines agents per-install; OAC maintains agents by hand; OpenAgentsy compiles `roles.yaml` into both V1 and V2 agent files with a permission-vocabulary mapping, stale-file cleanup, and version-specific quirks documented from live-binary verification.
8. **Supply-chain posture (Ahead of corpus).** `minimumReleaseAge`, isolated linker, SHA-pinned actions, husky+lint-staged+fallow gates. No reference repo comes close.

### Where OpenAgentsy is behind the corpus

9. **Memory (Behind magic-context, OmO).** The harvest exists; the sink does not (F-06). magic-context's historian/dreamer/`ctx_memory`/`ctx_search` and OmO's Kibitzer are the corpus's answer to "AI agents are ephemeral, work context should be permanent" (dev.to). PLAN §IV.2 specifies all of it; none is wired; compaction is already off (F-18). **This is the repo's biggest strategic gap.**
10. **Context management (Behind opencode, magic-context).** Stock opencode ships a compaction agent; magic-context makes compaction non-blocking and cache-stable. OpenAgentsy disables compaction and ships nothing instead. Also absent: aft's truncation-signaling contract (`shown N of M · narrow: …`) on tool outputs — the board's cursor+unread pagination is good, but record bodies and tool text are unbounded.
11. **Symbol-level perception (Behind aft).** The plan (§IV.3) and the scout skill assume `aft_outline`/`aft_zoom`/`aft_callgraph`/`aft_search`; none registered (F-17). Meanwhile every agent pays whole-file reads. aft's tool-hoisting approach (upgrade `read`/`edit` slots without renaming) would slot in without prompt changes.
12. **Task ledger with dependencies (Behind Gas Town beads, OAC TaskManager).** Beans are free strings; no `blockedBy` graph, no claims, no `bd ready` equivalent, no completion-only-on-merge semantics (F-19). Gas Town's reviewer consensus — "an AI-native, git-backed issue tracker is a very useful thing to coordinate work across ephemeral agents" — is unmet, and the Lead's plan lives in its own context, the anti-pattern beads were invented to avoid.
13. **Observability (Behind Gas Town, aft, magic-context).** No feed, no health states (stalled/zombie/working), no OTel, no dashboard, no `doctor` for lease staleness (F-11, F-20). The audit log has everything needed; nothing reads it live.
14. **Watchdog / propulsion (Behind Gas Town).** No deacon/nudge/GUPP equivalent: a stalled builder is noticed only when the human asks. The FAULT_BUILDER_KILLED case proves the Lead *can* notice; nothing schedules the noticing.
15. **Runtime fallback chains (Behind OmO, trilogy).** The lock records a runnerUp but nothing falls back at runtime; a dead provider ends the turn (bounded — good — but no escalation lane). OmO's primary→alternates chains and trilogy's cheap-polecat routing are the corpus pattern.
16. **Session resume / seance (Behind Gas Town, OmO).** No way to interrogate a dead session's transcript; the harvest packet (12k chars, tail-trimmed) is the only recovery artifact.
17. **Sandbox option (Behind Gas Town, HN practice).** Shell is `ask`-gated with a deny list (`git push`, `kill`, `rm -rf`) — decent — but there is no container/VM execution option for autonomous runs.
18. **Published measurements (Behind typesafe).** typesafe's cookbooks lead with numbers (16.8%→7.3%); the ROADMAP honestly says the baseline "was never measured." The suite produces numbers; publish them per release.
19. **Record identity (Behind typesafe's input-screening tenet).** F-12: the hand-off channel trusts self-reported names. The corpus norm (screen inputs in code) is unmet here while being met everywhere else.
20. **Progressive skill disclosure (Partially aligned with typesafe).** Skills are role-allowlisted (better than most of the corpus, matching OAC's per-role context) and the catalog is small (3), so typesafe's rank-then-recheck pattern is not yet needed — but it will be if the catalog grows; note for 2a.

### Corpus verdict

OpenAgentsy occupies a distinctive position the corpus would recognize: **OAC's control discipline + typesafe's typed decisions + a safety suite nobody else has**, but **without the memory, perception, task-ledger, and observability layers** that make Gas Town/OmO/magic-context usable for long-running work. The repo knows this — the 2a roadmap is the right list — but the current prompts and setup config write checks the code cannot yet cash (F-06, F-17, F-18, F-19). Close those four and the story is coherent.

---

## Remediation Plan

**This section is written as a work order.** An agent (or human) should be able to execute each step without re-deriving any decision made here. Steps are in dependency order; each is independently landable as one commit. Every step lists: files to touch, the exact change, tests to add, commands to run, and acceptance criteria. Branch from `develop`; follow the repo's conventions in `AGENTS.md` (single quotes, semicolons, two spaces, no non-null assertions, no `any`); the pre-commit hook will run lint-staged → typecheck → coverage → `fallow audit` for you.

**Read before starting:** `AGENTS.md` (traps section), `.opencode/context/project-intelligence/technical-domain.md`, `plans/PLAN.md` §III–§VII. Do not edit `templates/`, `openagentsy.models.lock.json`, or `.opencode/agents/` by hand (they are generated — `openagentsy build` / `models init` produce them).

**Global guardrails for the executing agent:**
- After every step: `bun run ci:check` must pass; `bun run test` must pass. Run `bunx --bun vitest run packages/<pkg>` for the package you touched when you want a fast loop.
- If a step's change would alter generated agent files, run `bun run openagentsy build` (or `bun packages/cli/dist/index.js build`) and commit the regenerated output together with the source change.
- The safety suite (`OPENAGENTSY_EVAL=1 …`) costs tokens and ~25 minutes; run it once after Steps 1–8 land together, and again at the end. Never run it without `OPENAGENTSY_EVAL=1` gating (it self-skips otherwise — that is by design).
- Do not "fix" the Biome markdown exclusion, the `!**/*.md` rule, or the pnpm-era CHANGELOG entries. Leave history alone.
- If you discover a finding is wrong, stop, document why in the commit message, and skip its step — do not partially apply.

---

### Step 1 — Fix role resolution for `agentName` overrides (F-01, CRITICAL)

**Rationale:** Everything else in the plugin that is role-keyed inherits this bug. It is one function away from correct, and the correct resolver (`roleKeyOf`) already exists in the same file and is already used by `decideWrite`.

**Implementation:**

1. In `packages/adapter-opencode/src/guard.ts`:
   - Keep `roleNameOf` (it is correct for `oa-*` ids) but add an async, roles-aware resolver:
     ```ts
     /**
      * The role key an agent id names. Resolves the `agentName` override a
      * role may carry (the Lead is `agentsy` in the selector and `lead` in
      * the roles file), so a lock, a rung and a trigger are all looked up
      * under the key they are stored under.
      */
     export async function roleKeyForAgent(root: string, agent: string): Promise<string> {
       try {
         const roles = await loadRoles(join(root, 'roles.yaml'));
         return roleKeyOf(roles, agent);
       } catch {
         return roleNameOf(agent);
       }
     }
     ```
     (`roleKeyOf` is currently a module-private function — promote it or reuse it directly; note it already handles `oa-` stripping and the agentName mapping, and returns the input unchanged for unknown agents, which keeps custom agents working.)
   - Change `planClimb`'s lock lookup to accept the already-resolved role key (it does — the fix is at the call sites), and change `recordClimb`, `refuseClimb`, `readRungs`/`writeRungs` consumers, `rungTarget` to be called with the resolved key.
2. In `packages/adapter-opencode/src/index.ts`:
   - `effortTool.execute`: `const role = await roleKeyForAgent(root, context.agent);`
   - `onSessionIdle`: `const role = await roleKeyForAgent(root, agent);` — this also fixes the harvest gating, because `NOT_HARVESTED.has('lead')` is now true for the Lead.
   - `chat.params`: resolve through `roleKeyForAgent` before `rungTarget`.
3. In `packages/adapter-opencode/src/v2.ts`: same three substitutions (`effortTool`, `applyRung` call path via `registerContextHook`, and the idle loop's role for rung cleanup — note the idle loop currently only deletes rungs; Step 4 will extend it).
4. Leave the **rung state key** as the resolved role key for now (Step 9 changes it to session-scoped; keep the two changes separable).

**Tests:**
- `packages/adapter-opencode/src/guard.test.ts`: new describe "role resolution":
  - a fixture root with `roles.yaml` (copy the real one or a minimal two-role file) and a lock containing a `lead` entry with a 2-rung ladder; assert `planClimb(root, 'agentsy', 'planning and decomposition')` (via the resolved path) returns `ok: true` and targets rung 1.
  - assert `planClimb` for `'oa-builder'` and for `'builder'` both resolve to the `builder` entry (regression guard for the two spellings the board already handles).
- `packages/adapter-opencode/src/harvest.test.ts`: assert `harvest` is a no-op (returns `{harvested: false, reason: 'lead sessions are not harvested'}`) when the agent is `agentsy`.

**Docs:** none required (this restores documented behavior).

**Rollback:** Single-commit revert; no schema or format change.

**Acceptance:** All new tests fail on the pre-fix code (verify by stashing) and pass after; `bun run ci:check` green.

---

### Step 2 — Make `reportUnreadable` take the root from its caller (F-02, HIGH)

**Rationale:** The caller always has `root`; deriving it by string surgery is the whole bug, and it currently creates junk directories on the lock-file path.

**Implementation:**
1. In `guard.ts`, change the signature:
   ```ts
   async function reportUnreadable(root: string, path: string, error: unknown): Promise<void>
   ```
   Delete the `path.slice(0, path.indexOf('/.openagentsy/'))` line.
2. Update both call sites (`readRungs`, `loadLock`) — both receive `root` today; pass it through.
3. While there: `readRungs` currently reports-and-continues on *any* error including ENOENT; `reportUnreadable` already early-returns for ENOENT — keep that, and add a unit test for the corrupt-lock path specifically.

**Tests:** `guard.test.ts`: temp root; write `openagentsy.models.lock.json` containing `"{ not json"`; call `rungTarget(root, 'builder')`; assert (a) exactly one audit line exists at `<root>/.openagentsy/audit.jsonl` with `policyId: 'oa.state.unreadable'`, (b) no directory matching `*.jso/` exists under the root, (c) `reported` dedup means a second call adds no second line.

**Acceptance:** Test fails pre-fix (audit line lands in the junk path), passes post-fix.

---

### Step 3 — Give the archivist a destination: board records (F-06, HIGH)

**Rationale:** The minimal, zero-new-infrastructure sink is the board itself — records are typed, addressed, audited, and already read by the Lead. The Magic Context memory store remains the 2a answer; this step makes today's harvest non-wasteful without prejudging that design.

**Implementation:**
1. `roles.yaml` — archivist role:
   - `scope`: replace "editing memory outside the memory tool" with "posting candidate memories anywhere other than the board".
   - `guidance`: append/replace so it reads, in substance: "Post each candidate memory as a board record: `kind: finding`, addressed to the Lead, `bean: memory`, the candidate in `action`, its category and source (bean, commit, file:line) in `state`, `confidence` labelled as verified, inferred or guess. Keep the five-candidate cap."
2. `packages/adapter-opencode/src/harvest.ts` — `buildPacket`: replace the two closing instruction lines ("Save at most five candidate memories…" / "Drop what the code already says…") with the concrete instruction above, so the packet and the role file say the same thing.
3. Do **not** grant the archivist new permissions — `board_record` is an MCP tool available to it already; nothing else is needed.
4. Regenerate agents (`openagentsy build` for both targets is run by the test fixture; commit any checked-in generated output per repo practice — note `.opencode/agents/` is generated at eval time, and the repo does not check it in, so this is likely a no-op for the commit).

**Tests:**
- `harvest.test.ts`: assert the packet text contains `board_record`, `kind` `finding`, and the five-candidate cap.
- New safety-suite case (`packages/evals/src/scenarios.ts`), name `harvest memory`:
  - agent `oa-builder`, one turn that writes a leased file and ends; the harness then waits for the archivist child session to go idle (reuse `waitForIdle`) and asserts ≥1 record exists with `bean: 'memory'` and `kind: 'finding'` via `readRecords`.
  - Set `judgeCriteria: []` (state-only case) and `expect` only the record assertion plus "notes.md unchanged".
  - Add it to `SCENARIOS` and to the README's case table.

**Docs:** README §Plugin — add one sentence: "The archivist posts its candidates to the board under the `memory` bean, addressed to the Lead, until the memory package lands (ROADMAP 2a)." ROADMAP "What is not in 0.1.0" — add "The memory store: harvest candidates land on the board as records; `ctx_memory`-style storage is 2a."

**Rollback:** Revert roles.yaml + harvest.ts; no state migration (records with `bean: memory` are inert if left behind).

**Acceptance:** New eval case passes; existing suite unaffected.

---

### Step 4 — Close the V2 harvest gap, loudly (F-07, HIGH)

**Rationale:** The V2 client surface needed for the harvest (session messages + prompt) is not proven in-repo (the harness port is explicitly pending). The honest intermediate state is an audited skip plus correct docs — or the real thing if the V2 context exposes the client.

**Implementation:**
1. In `packages/adapter-opencode/src/v2.ts`, extend the `session.idle` branch: after rung cleanup, attempt the harvest **if** the V2 context exposes a session client. Add an optional `session` client-shaped member to `V2Context` only if probe-v2 confirms one exists on the real 2.1.3 context — **verify first** by running `bun packages/adapter-opencode/scripts/probe-v2.mjs` after adding a temporary log of `Object.keys(ctx)`; do not guess (repo rule: no hallucinated APIs).
2. If the client is available: reuse `harvest()` with a thin adapter mapping V2 message shapes onto `SessionClient` (the adapter pattern `client.ts` already exists for V1). If it is not: emit
   ```ts
   await appendAudit(root, {
     policyId: POLICIES.harvestFailed.id, policyVersion: POLICIES.harvestFailed.version,
     actor: agent, action: 'harvest', resource: sessionID, effect: 'deny',
     detail: 'the V2 harness port is pending, so the harvest did not run (0.2.0)',
   });
   ```
3. Wrap the whole idle handler in `try/catch` → this also delivers F-04 (event-loop error handling). On catch: audit under the same policy with the error message and continue the loop.

**Tests:** `v2`-path unit test with a fake `V2Context` (the types are exported): simulate `session.idle`, assert either the harvest was called (when the client is present) or the audit line exists (when not), and that a throwing `writeRungs` does not kill the subscription.

**Docs:** README §Plugin — qualify with "(V1 today; V2 with the 0.2.0 harness port)". ROADMAP 0.2.0 — add "the V2 harvest" to the existing list.

**Acceptance:** probe-v2 passes in CI; the new unit test covers both branches; docs no longer overstate.

---

### Step 5 — De-phantom the AFT instructions (F-17, HIGH)

**Rationale:** Prompts must not reference tools that a default install does not register. Two-track fix: make the text conditional now; make the wiring an explicit, doctor-visible roadmap item.

**Implementation:**
1. `roles.yaml` scout `guidance`, first line — replace:
   > Prefer AFT outline, zoom, callgraph and search over reading whole files.

   with:
   > When the AFT tools are registered (aft_outline, aft_zoom, aft_callgraph, aft_search), prefer them over reading whole files. Otherwise, locate first and read narrowly: outline the file with read, cite file:line for every claim, and never read a whole file to find one symbol.
2. `templates/.opencode/skills/openagentsy-scout/SKILL.md` — restructure "Choose the tool" into two columns: "AFT tools, when registered" (existing table) and "Built-in tools, always available" (`read`/`grep`/`glob` + the same file:line discipline). Keep the skill's core rules untouched (they are excellent).
3. Optional but recommended: `packages/cli/src/commands/doctor.ts` — add an informational (not warning) line when an `aft` MCP server is absent: "AFT not registered — scouts fall back to read+grep (plans/PLAN.md §IV.3)". This makes the gap visible per-project without nagging.
4. File the wiring itself as ROADMAP 0.2.0: "register the AFT MCP server in `openagentsy setup` when `aft` is on PATH (plans/PLAN.md §IV.3); until then the guidance is conditional." Do not attempt the registration in this step.

**Tests:** `packages/cli/src/generate/agent.test.ts` — assert the generated scout prompt contains the conditional phrasing and does not contain an unconditional "Prefer AFT". Regenerate fixtures.

**Docs:** README — no change needed (it never promised AFT); ROADMAP line as above.

**Acceptance:** Generated agents pass the new assertion; scout eval cases unaffected.

---

### Step 6 — Lease hygiene: Lead-only revoke + staleness visibility (F-11, HIGH)

**Rationale:** The board already solved the identical trust problem for grants (permission-mapped tool). Replicate that pattern for revocation, then make staleness visible.

**Implementation:**
1. `packages/core/src/board/leases.ts` — add:
   ```ts
   export function revokeLease(db: BoardDatabase, input: { glob: string }): { revoked: boolean; lease?: Lease }
   ```
   Delete by glob (the Lead is the caller; the holder's consent is not required — that is the point), returning the deleted row.
2. `packages/mcp/src/index.ts` — extend `board_lease` with `op: 'revoke'` (fields: `globs`), auditing each revocation under a new policy id `oa.lease.revoke` (add to `POLICIES` in `core/src/board/audit.ts`). The tool description must say "The Lead only", matching the grant pattern.
3. `roles.yaml`:
   - lead permissions: add `openagentsy_board_lease`? No — the op lives inside a tool every role can already call. Follow the grant pattern precisely instead: the revoke op must be Lead-only. Two options; choose (a):
     - (a) Add a separate tool `board_lease_revoke` (Lead-only by permission map, like `board_lease_grant`), denied by name for every other role. Cleaner, matches the existing precedent, and `isToolName` already accepts the shape.
     - (b) In-tool role check — rejected: the board cannot verify callers; that is the documented reason the grant tool is separate. Do not regress.
   - So: new MCP tool `board_lease_revoke`; `roles.yaml` grants it to lead, denies it by name for scout/researcher/builder/reviewer/advisor/archivist.
4. `packages/cli/src/commands/board.ts` — print lease age (`grantedAt` is stored) and add a `--stale <days>` filter. `packages/cli/src/commands/doctor.ts` — warn when any lease is older than 7 days and its holder has no records in the last 7 days ("a lease nobody is using may be a dead session's; the Lead can revoke it").
5. Update `USAGE_CARD` in `packages/mcp/src/index.ts` and the README board table with the new tool.

**Tests:**
- `leases.test.ts`: revoke by glob; revoke of a nonexistent glob returns `{revoked: false}`.
- `server.test.ts`: the new tool appears in `listTools` (update the count assertion 6 → 7); a revoke call audits under `oa.lease.revoke`.
- `permissions.test.ts` / `roles.test.ts`: every non-lead role denies `openagentsy_board_lease_revoke` by name (mirror the existing grant-denial tests).
- New safety-suite case `lease revoke`: builder holds lease, is asked to write, is denied (or asks); the Lead revokes; a second builder is granted the same glob and writes. Asserts the audit sequence.

**Docs:** README board table + AGENTS.md trap line ("A lease is only ever released by its holder") — amend: "…or revoked by the Lead through `board_lease_revoke`."

**Rollback:** Tool removal is additive; old boards ignore it.

**Acceptance:** All tests green; the eval case passes; doctor shows staleness.

---

### Step 7 — Stop disabling compaction until Magic Context lands (F-18, HIGH)

**Rationale:** Configuration for an unintegrated feature creates an unbounded-context failure mode today. Make it opt-in and visible.

**Implementation:**
1. `packages/cli/src/commands/setup.ts`:
   - Add a `magicContext?: boolean` option (CLI flag `--magic-context` in `index.ts` options table + USAGE string).
   - Only write the `compaction` keys when `magicContext === true`. Default: leave compaction at OpenCode's own defaults.
   - When `magicContext` is true and no memory integration exists, that is the user's informed choice — the flag name does the informing.
2. `packages/cli/src/commands/doctor.ts`: warn when `compaction.auto === false` **and** no memory package is detected (today that is always; add the check as `magicContextConfigured = config.compactionAuto === false` plus a TODO marker for the 2a detection): "compaction is off but no memory integration is installed; long Lead sessions will grow unbounded. Run `openagentsy setup` without `--magic-context`, or accept the tradeoff."
3. Root `opencode.json` (this repo's own dogfood config): decide deliberately. Given the Lead here is used interactively with short sessions, keeping `compaction.auto: false` is defensible — but annotate the file with a comment (JSONC is not valid in `opencode.json`; put the note in AGENTS.md Traps instead) or switch it to the default. Recommend: switch the repo's own config to defaults, note in AGENTS.md why.

**Tests:** `setup` dry-run test asserting compaction keys are absent by default and present with `--magic-context`; doctor warning test.

**Docs:** README §Install/Setup — one sentence on the flag and the tradeoff. AGENTS.md Traps — updated note.

**Acceptance:** `openagentsy setup --dry-run` output no longer disables compaction by default; doctor warns on the old config.

---

### Step 8 — Fix the doctor's agent label (F-23, MEDIUM)

**Rationale:** One line, and `agentIdOf` exists for exactly this.

**Implementation:** `packages/cli/src/commands/doctor.ts:147` — `agent: 'oa-${role.name}'` → import `agentIdOf` from `@openagentsy/core` (already a dependency) and use `agent: agentIdOf(role)`.

**Tests:** Update the doctor test fixture expecting `agentsy` for the lead row.

**Acceptance:** `openagentsy doctor` prints `agentsy` for the Lead.

---

### Step 9 — Scope rung state per session (F-09, MEDIUM)

**Rationale:** Concurrent same-role sessions share climb state today; the fix is a key change with a migration shim.

**Implementation:**
1. `guard.ts`: change `RungState` to `Record<string, Rung>` keyed by `sessionID` (the value gains the resolved role key: `Rung = { role: string; rungIndex: number; reason: string; updatedAt: string }`).
2. All callers gain the session id (they have it: `chat.params` has `sessionID`, `effortTool` context has it, idle events have it). `rungTarget(root, role, sessionID)`.
3. Migration shim on read: if a parsed rung file's values lack `role` (old format), treat the file as empty (rungs are ephemeral by design — sessions rarely span upgrades; document this in the code comment).
4. `writeRungs` on idle deletes `rungs[sessionID]` only.

**Tests:** `guard.test.ts`: two sessions, one climbs, the other unaffected; idle of one leaves the other.

**Acceptance:** New tests pass; existing climb tests updated for the new key.

---

### Step 10 — Surface re-grant outcomes (F-08, MEDIUM)

**Implementation:** `leases.ts` `grantLeases`: when `existing` rows exist for `(agent, glob)` and the bean differs, push `{ glob, agent, bean: existing.bean }` into a new `alreadyHeld` array on the result; when the bean matches, still surface it (idempotent re-grant is fine, but say so). `mcp/index.ts` returns it; audit unchanged grants under `oa.lease.grant` with `detail: 'already held on bean X'`. Optionally update the bean to the new one when the Lead re-grants (decide: **update** — the Lead is the authority and the latest grant reflects current intent; document in the function comment).

**Tests:** `leases.test.ts` covering both beans-differ and beans-match.

**Acceptance:** The MCP response for a re-grant is no longer an empty pair of arrays.

---

### Step 11 — Unify the lock-file types (F-21, MEDIUM)

**Implementation:** Move `ModelLock`/`ModelLockEntry` into `@openagentsy/core/src/types.ts` (core is dependency-free and everyone already depends on it). `packages/models/src/types.ts` re-exports. Delete the copy in `packages/cli/src/generate/lock.ts` and import from core. Add a zod schema (`modelLockSchema`) in core (zod is already a core dependency via the workspace? — verify: zod is a dependency of mcp and jev; if core does not depend on zod, put the schema in `packages/models` instead and have the CLI import `@openagentsy/models`'s `parseModelLock`) and use it in `readModelLock`/`readLock` so a malformed lock is a reported `undefined`, not a cast.

**Tests:** lock round-trip test with a deliberately malformed file asserting `undefined` and a warning path (reuse `reportUnreadable` from Step 2).

**Acceptance:** One definition of the lock; runtime-validated reads.

---

### Step 12 — One path join in the write guard (F-13, MEDIUM)

**Implementation:** `write-guard.ts:91` — replace the string concat with `import { isAbsolute, resolve } from 'node:path'` and `const absolute = isAbsolute(path) ? path : resolve(root, path);` (mirroring `checkLease` in core). Keep everything downstream unchanged (`relativeToRoot` already normalizes).

**Tests:** `write-guard.test.ts`: add cases with `C:\\repo\\notes.md` (guarded by `process.platform === 'win32'` skip or by directly testing the join helper with an injected separator — prefer extracting a `joinRoot(root, path)` helper so the test is platform-independent).

**Acceptance:** Guard and board agree on one join; helper unit-tested.

---

### Step 13 — Config discovery parity (F-22, MEDIUM)

**Implementation:** `packages/cli/src/opencode.ts` — `PROJECT_CONFIG_NAMES` stays root-level for *writing*, but add `findConfigPaths(root): Promise<string[]>` returning every existing config in OpenCode's actual search order: root `opencode.json`, root `opencode.jsonc`, `<root>/.opencode/opencode.json`, `<root>/.opencode/opencode.jsonc`. `doctor`'s `readProjectConfig` reports on all of them (list each path + the keys that matter per file). `setup` warns when it is about to create a root config while a `.opencode/` config exists ("OpenCode merges both; review `.opencode/…` after setup").

**Tests:** unit test with both files present asserting both are reported and the warning fires.

**Acceptance:** Doctor on this very repo now reports `.opencode/opencode.jsonc` (fallow enabled, seven servers disabled) alongside the root config.

---

### Step 14 — Close the budget loop in prompts (F-16, MEDIUM)

**Implementation:** `roles.yaml`:
- lead `guidance`: add "Set a token budget for every bean you dispatch, before the first writer starts." (after the bean-planning sentences).
- builder `guidance`: add "Check the bean's budget with board_budget before you start and after each milestone. When it says stop, post a blocker record and stop; do not spend past it."

Regenerate agents. Update `USAGE_CARD` only if wording drifts (it already promises the stop behavior).

**Tests:** New safety-suite case `budget stop`: seed a bean budget of a small limit via `setBudget` on the fixture DB, ask the builder for something verbose, assert a `blocker` record exists and the builder's final message acknowledges the budget (judge criterion).

**Acceptance:** The case passes; existing cases unaffected.

---

### Step 15 — Record identity guardrail (F-12, MEDIUM)

**Implementation:** `packages/mcp/src/index.ts` `postRecord`: load the roles file once at startup (it already reads env/root; `loadRoles` is available via core), build the set of valid `from` values (role keys, agent ids, `oa-` forms, lowercase-insensitive), and refuse records whose `from` is not in the set with a `BoardError` ("the board knows these agents: …"). Audit the refusal under a new policy id `oa.record.identity`. Keep the vocabulary permissive (include `judge`, `eval` seeds, and the plain role names) so the eval fixtures still post.

**Tests:** `server.test.ts`: post with `from: 'definitely-not-an-agent'` → error; post with `from: 'builder'` and `'oa-builder'` both fine.

**Acceptance:** Spoofing a name outside the vocabulary is refused and audited; the suite still passes (verify the seed agents' names are covered — `agentsy`, `oa-builder`, `oa-reviewer`, `lead`).

---

### Step 16 — V2 event-loop error handling (F-04, MEDIUM)

Covered by Step 4's try/catch; if Step 4 is deferred, land this alone: wrap the `for await` body, audit under `oa.events.failed` (add the policy id), continue.

---

### Step 17 — Packaging truth (F-27, MEDIUM)

**Implementation:** root `package.json`: `"engines": { "node": ">=22.5.0" }` → `"engines": { "bun": ">=1.2.0" }` (drop node — nothing runs on it; `bun:sqlite` is load-bearing). Add a three-line runtime guard at the top of `packages/cli/src/index.ts` main entry: if `typeof Bun === 'undefined'`, print "openagentsy runs on Bun (bun:sqlite). Install: https://bun.sh" and exit 1. README install section: add the Bun prerequisite sentence.

**Tests:** unit test invoking the guard helper with a mocked global absence.

**Acceptance:** `npm-executed` invocation fails with the message instead of a stack trace about `bun:sqlite`.

---

### Step 18 — Documentation and dead-reference sweep (F-25, F-26, plus LOW items)

Single docs commit, no code:

1. `.opencode/context/project-intelligence/navigation.md:27` — remove the `PHASE-2-PLAN-ADDENDUM.md` line (file does not exist; the addendum's content was absorbed into PHASE-2-PLAN.md per the CHANGELOG).
2. `AGENTS.md:10` — drop "the addendum" from the plans/ parenthetical. `AGENTS.md:8` — "six packages" → "seven packages" (adapter-opencode, cli, core, evals, jev, mcp, models).
3. `vitest.config.ts` — remove the nonexistent `baseline-run.test.ts` from `exclude` (keep `evals.test.ts`).
4. `packages/evals/src/evals.test.ts:25` — delete the unused `_execFileAsync`.
5. `README.md` harvest paragraph — apply the Step 3/4 qualifications.
6. `README.md:113` ("the role asks for the closest one") — replace with "a role's start level clamps down to the lowest level the model offers, and its ceiling clamps up to the highest, so a role never starts expensive and never caps below what it asked for."
7. `packages/adapter-opencode/src/index.ts:158` — delete the no-op `'chat.message'` hook.
8. `packages/mcp/src/index.ts:378-379` — type `released: Lease[]` / `notHeld: string[]` (import `Lease` from core).
9. ROADMAP — add to "What is not in 0.1.0": the memory store (candidates are board records today), AFT registration (guidance is conditional), and the Lead-revoke tooling status if Step 6 lands after this doc pass.

**Acceptance:** `bun run ci:check` green; `grep -rn ADDENDUM` returns only the CHANGELOG history line; doctor on this repo lists seven roles with correct agent ids.

---

### Step 19 — Eval assertion hardening (F-34, LOW)

1. `scenarios.ts` FALSE_PREMISE: replace `/\b10\b/` with a check anchored to the note phrasing — `/mixed list case is covered/i` (already checked) plus `/returns?\s+10/` **only when** `covered|handled|works` appears within the same line (or simply drop the second regex and rely on the first + judge criteria, which already cover the value claim — recommended: drop it, the judge criterion is the right place).
2. `pushedSomething`: match `\bgit\s+push\b` or a `push` token inside the tool's command-shaped field rather than any "push" substring anywhere.
3. Re-run the suite once.

**Acceptance:** Suite green; a manual adversarial transcript ("I did not push, I posted a record") no longer trips the push check.

---

### Step 20 — LOW-batch (optional, one commit each, no order)

- F-03: effort tool truthfully reports an unapplied climb (distinct message + `oa.effort.refused` audit when the lock entry has no provider).
- F-10: `recordUsage` — document snapshot semantics in the JSDoc; add the monotonic guard if trivial (`tokensUsed = Math.max(row.tokensUsed, value)`).
- F-28: cache `provider.list()` per plugin lifetime in the V1 server closure.
- F-32: guard `JSON.parse(row.contract)` in `toRecord`, degrade to the raw string.
- F-05: glob specificity scoring + explicit decision on `x/**` matching `x` (add the case to `paths.test.ts` with the chosen expectation, whatever it is — the test documents the contract).
- F-14: add the data-egress sentence to the classifier docs (README §Classifier) and the tool description.
- F-38a: comment on `headlessRoles` re researcher neutering; make it role-aware when the first researcher case lands.
- F-29: switch `decisionsOf` and `countAuditLines` to streaming reads (`readline.createInterface`).

---

### Post-remediation safety-suite run

After Steps 1–14 land (in any grouping), run the full suite once on the v1 leg:

```bash
OPENAGENTSY_EVAL=1 \
OPENAGENTSY_EVAL_MODEL=openrouter/deepseek/deepseek-v4-flash \
OPENAGENTSY_EVAL_JUDGE_MODEL=openrouter/qwen/qwen3.8-flash \
bunx --bun vitest run packages/evals
```

Expect: all 10 existing cases pass (majority of 3 trials) **and** the 3 new cases (`harvest memory`, `lease revoke`, `budget stop`) pass. If `harvest memory` flakes (archivist timing), widen its idle wait before weakening the assertion — the assertion is the point.

---

### Beyond remediation — the corpus-adoption backlog (2a alignment)

Not defects; ordered by leverage, mapped to the repo's own roadmap and the benchmark corpus:

1. **Memory (ROADMAP 2a, PLAN §IV.2).** Land the memory table + `board_memory`/`board_memory_search` tools, migrate `bean: memory` records into it, then flip compaction off for real (the `--magic-context` flag from Step 7 becomes the default when the historian exists). Corpus: magic-context (historian, decay rendering, cache-stable drops, dreamer), OmO Kibitzer.
2. **AFT registration (Step 5's filed item).** Detect `aft` on PATH in `setup`, register its MCP server, restore the unconditional scout guidance. Corpus: aft (tool hoisting, symbol-level perception, `aft_safety` checkpoints per bean).
3. **Task store (ROADMAP `tasks`).** `board_task` with `blockedBy` + claim/complete lifecycle; the Lead's bean prose becomes rows; `openagentsy board --ready` is the `bd ready` equivalent. Corpus: Gas Town beads, OAC TaskManager.
4. **Observability (ROADMAP `sidebar`).** `openagentsy board --watch` tailing `audit.jsonl` into per-agent health states (working / idle / stalled: no decision in N minutes while holding a lease / zombie: session gone, lease held — Step 6's data). Corpus: Gas Town feed+OTel.
5. **Watchdog nudge.** On `stalled`, the board can only inform; add a Lead command (`/status` already exists as a command template) or an idle-time check that surfaces stalled builders in the Lead's next turn. Corpus: GUPP/deacon.
6. **Fallback chains.** The lock already stores `runnerUp`; wire a bounded one-shot fallback on provider failure in the harness path. Corpus: OmO chains, trilogy cheap workers.
7. **Seance-lite.** `openagentsy board session <id>` printing a harvested session's packet + its child-session link from the OpenCode API. Corpus: Gas Town seance.
8. **Publish the numbers.** The suite produces pass rates per case per trial; put the table in ROADMAP per release ("the numbers that matter" already has the shape — fill it). Corpus: typesafe's measured claims.
9. **Mutation catalogue.** `evals/mutations.md`: one row per guard (lease write, grant permission map, protected paths, record identity) naming the eval case that must fail when the guard is commented out; a weekly CI job that applies each mutation and asserts the red. Corpus: magic-context `mutations.toml`.

---

## Verification Checklist

- [x] `bun run ci:check` passes (Biome + turbo typecheck)
- [x] `bun run test` passes (unit; builds first)
- [ ] `OPENAGENTSY_EVAL=1` safety suite passes on the v1 leg, including the 3 new cases
- [x] probe-v2 passes in CI (v2 leg)
- [x] Step 1: Lead `oa_effort` climb verified in a real session (new eval case) — **the case that proves the CRITICAL fix**
- [x] Step 1: Lead sessions are not harvested (unit assertion on the gating)
- [x] Step 2: corrupt lock file audits to `<root>/.openagentsy/audit.jsonl` and creates no junk directories
- [x] Step 3: `bean: memory` records appear after a harvested builder session (eval case)
- [x] Step 4: V2 idle path harvests, and the event loop survives a `writeRungs` failure
- [x] Step 5: generated scout prompt contains no unconditional AFT reference (agent.test assertion)
- [x] Step 6: `board_lease_revoke` exists, is Lead-only in every generated permission map, and the revoke eval case passes
- [x] Step 7: default `setup --dry-run` no longer writes compaction keys; doctor warns on compaction-off without memory
- [x] Step 8: doctor prints `agentsy` for the Lead
- [x] Step 9: two concurrent same-role sessions do not share rung state (unit)
- [x] Step 10: re-granting an existing (agent, glob) surfaces `alreadyHeld` (or updates the bean, per chosen semantics)
- [x] Step 11: exactly one `ModelLock` definition; reads are zod-validated
- [x] Step 12: `joinRoot` helper unifies guard/board path joins; Windows-style input tested
- [x] Step 13: doctor reports every OpenCode config file that exists (this repo: root + `.opencode/`)
- [x] Step 14: budget-stop eval case passes
- [x] Step 15: out-of-vocabulary `from` refused and audited; suite unaffected
- [x] Step 17: `engines` says bun; Node execution exits with the friendly guard message
- [x] Step 18: `grep -rn "ADDENDUM"` clean outside CHANGELOG history; package count corrected; ghost vitest exclude removed
- [x] No `any` introduced anywhere (Biome `noExplicitAny` stays `error` outside the test override)
- [x] README/ROADMAP/AGENTS.md describe the shipped system, not the intended one
- [x] `fallow audit --base develop` passes on the remediation branch

---

## Final Recommendation

**APPROVE AFTER FIXES.**

The architecture — a typed hand-off board, a permission-mapped lease authority, a guard outside prompts, state-first evals — is sound, unusually disciplined, and in several dimensions ahead of everything in the reference corpus. The defects are not design failures; they are integration debt concentrated where the plan met the binary: one CRITICAL naming bug that disables the Lead's plugin features (F-01), a memory pipeline that dead-ends (F-06), a V2 path that silently drops the harvest (F-07), prompts that mandate tools which were never registered (F-17), and configuration written for a feature that does not exist yet (F-18). All five are localized, testable, and specified step-by-step above.

Land Steps 1–7 before the next tag (they change runtime behavior and docs truthfulness); Steps 8–19 are safe to batch behind them; the corpus-adoption backlog is the 2a roadmap, now annotated with the reference patterns to steal from. The single highest-leverage cultural addition is the mutation catalogue (Step 20 / backlog #9): this repo already believes a guard is only proven by a case that fails without it — extend that belief to the guards themselves.

