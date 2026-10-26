# OpenAgentsy: a parallel OpenCode agent, built on the evidence

**Build a hub-and-spoke system, not a swarm.** One long-lived Lead agent holds the plan and the memory. Read-only scouts fan out freely. At most three writers work in isolated git worktrees, each owning its own files. A reviewer on a different model, with a clean context, checks every change. Agents coordinate through Beans (task state) and a typed message board, not through free-form chat.

All coordination logic lives in MCP servers, so the same system runs on OpenCode V1 and V2. Each version gets a thin plugin adapter. The user names their providers (OpenCode Zen or Go, Ollama local or Cloud), and OpenAgentsy picks a model for each role using models.dev metadata, current BenchLM rankings, each provider's quotas, and a privacy filter. Each role has a ladder of reasoning-effort levels and models, and agents climb it only on concrete triggers. Every subagent searches shared memory, and when its session ends, what it learned is saved as candidate memory. Agents load task-specific skills (`SKILL.md` files) only when they need them, and procedures that recur become new skill drafts for a human to approve. OpenAgentsy is the executive layer that CortexKit announced as Alfonso but never shipped, sitting on top of Magic Context and AFT.

The design adapts darrenhinde/OpenAgentsControl's plan approval and scoped context, and code-yeongyu/oh-my-opencode's parallel background work, then adds what recent research says both of them lack: structured messages, independent verification, file ownership, and hard stop conditions.

**Using fewer tokens is a primary goal.** OAC-style minimal context, Magic Context, AFT, and typed hand-offs each cut tokens at a different layer (§III.7). The target is fewer tokens per resolved task than a plain OpenCode session, and each layer's savings get measured in Phase 0.

| Metric | Value | Source |
| --- | --- | --- |
| Multi-agent vs. single agent | **+81% / −70%** | Decomposable vs. sequential tasks (Kim et al.) |
| Failures from spec & coordination | **79%** | Not model capability (MAST, 1,600+ traces) |
| Unchecked multi-agent cost | **~15×** | Anthropic's research system vs. chat; the cost OpenAgentsy is built to avoid |
| Tokens per resolved issue | **−47%** | Typed action-state messages on SWE-agent (PACT) |

---

## I. What the evidence says

### 1. Parallelism pays only when the task splits cleanly

**The Lead has to decide, task by task, whether to parallelize.** A Google/MIT study ran 260 controlled configurations across six benchmarks. Multi-agent setups gained +80.8% on decomposable work and lost 70% on sequential planning. Coordination also stopped paying once the single-agent baseline was already strong. [[1]][1]

- Architectures without central verification spread errors more than centralized ones in the same study.
- Accuracy follows an inverted U as agents are added. It peaks around four agents, and reasoning tasks fall 27% from one agent to eight (SIMAS, Fudan).
- A single agent can match homogeneous multi-agent workflows more cheaply, because it reuses its KV cache. [[2]][2]
- Anthropic found that "most coding tasks involve fewer truly parallelizable tasks than research." Its research system costs about 15× the tokens of a chat.

### 2. Keep writes single-threaded per scope

**Many agents can contribute thinking, but each file should have exactly one writer at a time.** In its April 2026 follow-up to "Don't Build Multi-Agents," Cognition reports that the patterns working in production keep writes single-threaded, and that unstructured swarms are "mostly a distraction." [[3]][3]

- Cursor's flat, equal-status agents held locks too long, avoided hard tasks, and churned. Twenty agents produced the throughput of two or three. Separate planners and workers plus a judge fixed most of this. [[4]][4]
- Cursor also found optimistic concurrency more robust than locks. Beans already supports this through `ifMatch` etags.
- In Anthropic's swarm experiments, earlier models opened hundreds of PRs that never merged. Newer models avoided conflicts mainly by keeping ownership of their own files.

### 3. Messages between agents should be typed, not chat

**Pass an action-state record (what was done, the state it produced, the artifact, what is needed next), not the agent's transcript.** PACT cut tokens 38.7% on average without losing accuracy, and cut tokens per resolved issue 47% on SWE-agent. Forwarding full transcripts was the most expensive option and rarely the best. Generic "be brief" summaries were unstable. [[5]][5]

- A shared blackboard, where agents talk only through a common board, matched state-of-the-art systems while using fewer tokens (LbMAS).
- Claude Code Agent Teams shows when peer messages earn their cost: handing a backend API contract straight to the frontend teammate. [[6]][6]
- Cognition found that agents don't relay information to their manager by default. Reporting has to be a required field, not a hope.

### 4. Verification works best from a clean context

**The reviewer should see the diff and the acceptance criteria, not the builder's history.** Devin Review finds an average of 2 bugs per PR, 58% of them severe, and works best when coder and reviewer share no context beforehand. Context rot is the mechanism: long contexts make models reason worse. [[7]][7]

- MAST names missing or weak verification as one of three failure categories, across 7 frameworks. [[8]][8]
- Generation is no longer the bottleneck; verification is (Osmani, O'Reilly AI CodeCon, March 2026).

### 5. Identical agents fail the same way, and defer to the group

**Use different model families for building and reviewing, and collect each agent's independent judgment before it sees anyone else's.** In Anthropic's swarm runs, 18 of 30 identical agents created the same branch name. The same study found groups miss decisive facts that only one member holds. [9]

- Across 22,500 trajectories, including SWE-bench, simulated social pressure caused "cognitive loafing": agents complied with the group even when their own reasoning was correct. [[10]][10]
- Cognition's "smart friend" pattern works across frontier models, routing each sub-task to the model best at it rather than escalating by difficulty.

### 6. In context and memory, less is more

**Store non-obvious rules and constraints, not repo overviews.** ETH Zurich found that LLM-generated AGENTS.md files lower success by about 3% and raise cost by more than 20%. Developer-written files help by about 4%, and only when they state minimal requirements. [[11]][11]

- ACE shows that repeatedly rewriting a context erodes detail ("context collapse"). Grow a playbook through small incremental edits instead. [[12]][12]
- Procedural memory distilled from past runs raised success and cut steps, and still helped when moved from a stronger model to a weaker one (Mem^p, Zhejiang/Alibaba).
- A 2026 memory survey frames memory as how agents self-improve, which makes governing what gets stored a design problem in its own right. [[13]][13]

### 7. Relentless agents escalate

**"Never stop until done" needs a brake.** In one Anthropic experiment, three agents were each told to migrate the same backend to a different language. They sabotaged each other: killing each other's processes, revoking accounts, and disguising malware as another agent's code. The fix is one arbiter, explicit ownership, and a rule to escalate to a human instead of fighting.

- Practical guardrails from the field: cap retries (around 8), force a reflection step before each retry, and kill and reassign after 3 stuck iterations.

---

## II. Where OpenAgentsy sits between OAC and OMO

OAC chooses control; OMO chooses autonomy. The research supports control where mistakes compound (plans, writes, memory) and autonomy where they don't (reading, searching).

| | OpenAgentsControl | oh-my-opencode | OpenAgentsy |
| --- | --- | --- | --- |
| Human gates | Approve every write, shell command, and delegation | Fully autonomous | Approve the plan once. Ask again only when work leaves scope, is destructive, or edits policy files. |
| Parallelism | Sequential | Async background agents | Unlimited read-only scouts. Writers capped at 3, one per worktree. |
| Context | Minimal context files under 200 lines (MVI) | Injects AGENTS.md and README | Keeps MVI. Memory holds rules only, never overviews. |
| Task tracking | TaskManager subtasks | Todo enforcer forces continuation | Beans board with dependencies and etags. Continues only within step and token budgets. |
| Agent identities | Functional (OpenCoder, CodeReviewer) | Mythological personas (Sisyphus, Oracle) | Functional role names only (required by agentsy rules) |
| Verification | Test and review subagents | Self-correcting loop | Clean-context reviewer on a different model, plus test and inspection gates |
| OpenCode target | V1 (major rewrite announced) | V1 | V1 and V2 |

**Don't install OMO alongside Magic Context.** Magic Context turns itself off when OMO's preemptive-compaction, context-window-monitor, and limit-recovery hooks are active. Borrow OMO's ideas, not its package.

---

## III. Architecture

### 1. Seven roles, each with a written scope

| Role | Mode | Can write | Model guidance | Declared scope |
| --- | --- | --- | --- | --- |
| `lead` | primary | Beans, board, memory (gated) | Strongest planner | Plan, delegate, arbitrate, synthesize, report to the human. Doesn't edit source beyond trivial fixes. |
| `scout` | subagent | No | Fast and cheap | Map code with AFT outline, zoom, and callgraph. Return file:line findings. |
| `researcher` | subagent | No | Mid-tier | External docs, library source, changelogs. Every claim cites a source. |
| `builder` | subagent | Owned globs in its own worktree only | Strong coder | Implement one bean. Can't touch files it doesn't own; asks the owner instead. |
| `reviewer` | subagent | No (runs tests and lint) | **Different family from builder** | Review the diff against acceptance criteria, starting from a clean context. |
| `advisor` | subagent | No | Frontier, used rarely | "Smart friend" consult with a fork of the asker's context. Required for merge conflicts and architecture decisions. |
| `archivist` | hidden subagent | Memory only (`ctx_memory`) | Cheap, long context | Runs when any subagent session ends. Distills what's worth keeping and saves it as candidate memories with provenance. |

### 2. Adaptive dispatch

**The Lead classifies every request before spawning anything.** These effort rules follow Anthropic's published scaling heuristics and the measured inverted-U peak:

| Mode | When | Shape |
| --- | --- | --- |
| Solo | One file, sequential reasoning, or a bug hunt | Lead plus 0–2 scouts, one builder. No parallel writers. A sequential task is where multi-agent lost 70%. |
| Fan-out read | Unfamiliar code, research, triage | 2–6 scouts and researchers in parallel, one builder |
| Parallel write | Work splits into disjoint file sets with clear contracts | 2–3 builders in separate worktrees, plus one reviewer for every 3 builders |
| Design options | An ADR bean, or an open design question with several workable answers | 2–3 advisors or researchers on different model families draft options independently, then one critique round. The Lead writes the options into an ADR, and the human decides. |

The design-options mode adapts LLM Discussion's three phases (initiation, discussion, convergence). That framework beat single-model and other multi-model setups on creativity tests. [[19]][19] Two changes keep it in line with §I.5. Agents draft independently before they see each other's options. Debate stops after one round, because the bystander-effect study found group pressure overrides correct individual reasoning. Roles are perspectives (security, performance, maintainability), not personas, per agentsy. Its gains were measured on creativity tests, not code, so use it to widen the options, never to decide whether code is correct.

### 3. The shared workspace

**Three stores, each with one job.**

- **Beans = task state.** One epic per request, one child bean per unit of work. `blockedBy` holds dependencies, `beans_query ready` drives dispatch, and every claim uses `ifMatch`.
- **OpenAgentsy board = messages and leases.** A small MCP server holds typed records, file-ownership leases, budgets, and the audit log, stored as SQLite plus JSONL under `.openagentsy/`.
- **Magic Context = durable memory.** The Lead runs one long session. Every subagent can search memory with `ctx_search`. Subagents add to memory only through the archivist's end-of-session pass (§IV.2).

```jsonc
// Board record (PACT-style action-state; ~150 tokens max)
{
  "bean": "proj-42", "from": "builder-2", "kind": "status|contract|question|blocker|finding",
  "action": "Added GET /search?q= handler",
  "state":  "tests: 14/14 pass; owns src/api/search.ts",
  "artifact": "commit a1b2c3 on wt/proj-42",
  "contract": { "GET /search": "→ [{id,title,url}]" },
  "needs":  "frontend (proj-43) consume contract",
  "surprise": "Existing index lacks title column — migration added",
  "confidence": "verified|inferred|guess"
}
```

The `surprise` field addresses the hidden-profile failure: agents rarely volunteer the one fact only they hold unless the format asks for it. The `confidence` field applies agentsy's rule that agents separate facts, inferences, and guesses.

### 4. Who may talk to whom

**Hub and spoke, with typed side channels.** Every record goes on the board, so the Lead and the human see all of it.

- Builders may post `contract` and `question` records addressed to the owner of another bean. This is the one kind of peer messaging with a measured benefit.
- Only the Lead resolves conflicts. Two builders who want the same file get a lease decision, never a negotiation between themselves.
- Messages arrive at checkpoints: agents call `board_inbox` after each step. Records flagged as blocking get pushed. On V2 that means continuing the child session by `sessionID`; on V1 the adapter re-prompts the session.
- Scouts write findings first and read each other's afterward, so they don't anchor on the first answer posted.

### 5. The loop

1. **Intake.** Classify size, decomposability, risk, and mode. Ask clarifying questions before planning, not mid-build.
2. **Plan.** Create the epic and child beans. Each bean states objective, acceptance tests, owned globs, inputs, output format, budget, and `blockedBy`. These five fields are Anthropic's delegation checklist. **The human approves the plan.**
3. **Dispatch.** Pull ready beans, create a worktree, grant a file lease, set the AFT checkpoint, and launch a background builder.
4. **Build.** AFT edits, then local tests, then a status record. At 85% of budget the builder pauses and posts a blocker.
5. **Verify.** The reviewer gets the diff and acceptance tests only, and runs tests and `aft_inspect`. A failure returns structured findings. After 3 failed cycles, the bean goes to the advisor, then to the human.
6. **Integrate.** The builder rebases its own branch (Cursor found a separate integrator role created bottlenecks). The Lead merges and runs the full suite.
7. **Harvest.** When each subagent session ends, the archivist collects its materials: board records, diff, reviewer findings, failed attempts, and the session's compressed transcript. It saves the parts worth keeping as *candidate* memories.
8. **Learn.** Candidates become active memory once the dreamer has verified them against the code and the user has seen them in the run digest. The user can veto or edit any of them. Procedures that recur across beans become skill drafts instead (§IV.4).

### 6. Board API: borrow AIF's design, not its server

**dshein-alt/aif is a self-hosted forum where agents talk over REST and MCP, designed around token cost. Its interface choices fit the OpenAgentsy board; its server doesn't.** [[18]][18]

What to borrow:

- **One cheap inbox call.** AIF's `poll` returns only counts. `unread` returns the messages addressed to the caller and marks them read, in one response. `board_inbox` should work the same way, so an agent with nothing waiting spends only a few tokens.
- **Cursors, never histories.** Every read is a page from a cursor. Nothing returns the whole board.
- **A self-describing usage card.** AIF sends a usage card of about 1,000 tokens as the MCP `initialize.instructions`, so a client learns the API without extra prompt text. The board should do the same, and keep the card short (§I.6).
- **Errors that name the next call.** Every AIF error carries a `hint` saying what to do next, so agents don't have to guess how to recover.
- **Long-poll for urgent records.** AIF's `wait` delivers new messages almost immediately without a persistent connection. It's a candidate for pushing blocking records, alongside Magic Context's `agent.deliver`.
- **Credentials that form a tree.** Each AIF token descends from the one that issued it, and revoking a token revokes everything beneath it. Give each subagent a board token issued under the Lead's and limited to its epic, as AIF's private spaces do. Killing a builder then revokes its access in one call, and a scout can't read another epic's records.
- **A read-only view for people.** AIF serves a plain web page so humans can follow along. `openagentsy board --ui` gives the user the same view of records, leases, and budgets, which supports agentsy's transparency rules.
- **Operator commands.** AIF lets an operator send `RESET`, `SHUTDOWN`, or `KILL` to a running agent. OpenAgentsy gives the user the same three commands for any session and logs each one.

What to leave out:

- **Karma and votes.** Agents rating each other rewards agreement, which is the conformity failure in §I.5. Reviewer verdicts rest on tests and evidence.
- **The server itself.** AIF needs Docker and PostgreSQL. It stores tokens in plain text in the database, so anyone who can read the database can impersonate every agent. OpenAgentsy's board runs locally on SQLite. A bridge to an AIF server could come later, for teams that want agents on several machines in one forum.

### 7. Token economy: every layer cuts tokens

**Fewer tokens is a design goal, not a side effect.** Several agents will always cost more than one agent doing the same work with the same tools. So the savings have to come from every layer, and parallel work has to earn its extra cost. The target is fewer tokens per resolved task than a plain OpenCode session on the same tasks (§VIII.1).

| Layer | What it saves | How |
| --- | --- | --- |
| Context files (adapted from OAC) | Standing prompt size | Minimal context files under 200 lines. The scout loads only the files a bean needs, instead of putting AGENTS.md and the README into every session. |
| Magic Context | Lead history and repeated discovery | The historian compresses the Lead's history in the background instead of carrying full transcripts. `ctx_reduce` lets an agent drop context it no longer needs. Memory search replaces re-exploring what an earlier session already learned. |
| AFT | Code reading and command output | `aft_outline` and `aft_zoom` read symbols instead of whole files. Bash output compression shrinks test and build logs. |
| Board records | Hand-offs between agents | PACT-style records instead of transcripts: 38.7% fewer tokens on average, 47% fewer per resolved issue on SWE-agent. Inbox polls return counts only. |
| Subagent context | Each child's starting prompt | A child gets its bean, its leased files, and the skills its bean names, never the Lead's history or the whole skill catalog. |
| Dispatch | Number of agents | Solo is the default. Parallel modes run only when the task splits cleanly. |
| Model and effort ladders | Price per token | Cheap or local models for scouts, the archivist, and the historian. Higher effort only on rule-based triggers. |
| Stable prompt prefixes | Repeated input | Agent files put fixed text first and per-task text last, so provider prompt caching applies where the provider supports it. |

- **Budgets are enforced, not suggested.** Each bean carries a token budget, and at 85% the builder stops and posts a blocker. The run digest shows tokens per role and per bean, so the user sees where the tokens went.
- **The archivist is cheap, or skipped.** It runs on the cheapest long-context model and skips sessions with nothing new: no failures, no review findings, no surprises. When sessions are short, it harvests once per epic instead of once per session.
- **Design-options mode is reserved for ADR beans.** It's the most expensive mode and never runs by default.
- **Measure, don't assume.** This plan has no measured savings figures for Magic Context, AFT, or the OAC context approach on your repos. Phase 0 measures each layer by switching it off in turn on the same task set.

---

## IV. Wiring in Beans, Magic Context, AFT, and agent skills

### 1. Beans — superseded

**Superseded 2026-10-26.** No beans-mcp and no Beans CLI: Phase 2's `@openagentsy/tasks` re-implements the `.beans/` file format byte-compatibly and registers the `oa_task_*` tools (PHASE-2-PLAN §3). The Lead-owns-the-structure permission split lives in the board's own leases and budgets.

### 2. Memory — superseded

**Superseded 2026-10-24/26.** No Magic Context dependency. The archivist's harvest below is kept as built; candidates land on the board as `bean: memory` records, and Phase 2's `@openagentsy/memory` slice stores, redacts and searches them with a human-only decide (PHASE-2-PLAN §4). Compaction stays **on** by default (`--magic-context` is the informed opt-out), and `@openagentsy/tasks` injects the short state block instead of a beans prime.

**Subagent harvest.** When a child session finishes (V2 reports the result to the parent; V1 fires `session.idle`), the adapter assembles a harvest packet and launches the hidden `archivist`. The archivist writes at most five candidates per session. Each candidate gets one category, a source (bean ID, commit, and file:line), and a confidence label.

- **What gets kept:** constraints the code doesn't make obvious, gotchas that cost a retry, commands that worked, review findings that recurred, and procedures, which become playbook entries per ACE and Mem^p.
- **What gets dropped:** repo overviews and file summaries (the AGENTS.md study found these lower success and raise cost), anything the code already says, and claims labeled as guesses.
- **Promotion is the human-only decide:** the inbox is the pending `bean: memory` records; a person approves or rejects (`/oa memory <id> a|r`), `roles.yaml` denies `oa_memory_decide` to every agent role, and approvals append to `.openagentsy/memory.jsonl` at the state root. Search is `oa_memory_search`; unverified entries are redacted in results by default. There is no historian and no auto-injection in this slice (PHASE-2-PLAN §4).
- **Search:** every agent file allows the board and memory tools. A builder checks `oa_memory_search` before it starts a bean, and a scout checks before it explores.

### 3. AFT as everyone's editor

**AFT cuts the tokens each agent spends reading code and command output (§III.7).**

- Scouts use `aft_outline`, `aft_zoom`, `aft_callgraph`, and `aft_search` instead of reading whole files.
- Builders use symbol-level `edit` and `ast_grep_replace`, with an `aft_safety` named checkpoint per bean so a failed bean rolls back cleanly.
- `aft_inspect` serves as the reviewer's health gate (LSP errors, dead code, duplicates).
- Use bash output compression for test runners. Pick one background-task system per version: AFT's on V1, OpenCode's native background shell on V2.

### 4. Agent skills: native first, the plugin where it adds something

**Use OpenCode's built-in `skill` tool as the base on both versions. Add joshuadavidthomas/opencode-agent-skills on V1 only, for the extras it offers.** OpenCode now discovers and loads skills natively, and the plugin's author says most users no longer need the plugin. It's in maintenance mode, and it installs through V1's `plugin` array, so it won't run on V2. [[17]][17]

- **Why skills fit the evidence.** Only a skill's short description sits in context; the body loads when an agent needs it. That matches the AGENTS.md finding to keep standing context minimal (§I.6), and Mem^p's finding that reusable procedures help. Skills use the Anthropic Agent Skills format, so the same files also work in Claude Code.
- **What to keep from the plugin on V1:**
  - `read_skill_file` and `run_skill_script`, for skills that ship reference files and scripts.
  - Semantic matching, which notices when a message relates to a skill and prompts the agent to load it. It embeds messages locally with Transformers.js, which downloads its model from Hugging Face on first run.
- **What to leave off:**
  - Compaction reinjection does nothing here, because Magic Context requires compaction to be off.
  - Superpowers mode imposes its own workflow, which would compete with the Lead's loop.
  - The automatic `<available-skills>` list goes only into the Lead's session. Each subagent gets the skills its bean names, not the whole catalog.
- **On V2, port the extras into OpenAgentsy's MCP server,** as with adaptive effort: semantic matching plus `read_skill_file` and `run_skill_script` equivalents. Both versions then behave the same, and the plugin can be dropped when V1 support ends.
- **Per-role skill access.** `roles.yaml` lists which skills each role may load, and the generator writes the matching skill permissions into each agent file. A builder on a migration bean gets `db-migrations`, not the whole catalog.
- **Skill scripts count as shell commands.** `run_skill_script` executes code, so it follows the role's shell rules: `ask` by default, allowed only for scripts listed in `roles.yaml`. Every run goes to the audit log.
- **Show where skills come from.** Discovery reads project and user directories, including Claude Code's, and the first skill found with a given name wins. A user-level skill can quietly shape every project, so `openagentsy doctor` lists each skill found and its path.
- **Learned procedures become skill drafts.** When the archivist sees the same procedure succeed across several beans, it writes a `SKILL.md` draft with its sources to `.openagentsy/skill-drafts/`. The draft moves into `.opencode/skills/` only after a human approves it. Every future agent will follow a skill's instructions, so an unreviewed skill is an opening for prompt injection.

---

## V. Choosing models and reasoning effort automatically

### 1. The user names providers; OpenAgentsy picks the models

**Running `openagentsy models init --providers opencode-go,ollama-cloud` fills every role slot with a model, says why it picked each one, and asks the user to confirm.** It works in these steps:

- **Inventory.** Gather what each chosen provider actually serves: `opencode models` output for Zen and Go, `GET /api/tags` on `localhost:11434` for local Ollama, and the same endpoint on `ollama.com/api` with `OLLAMA_API_KEY` for Ollama Cloud.
- **Metadata from models.dev.** OpenCode builds its own model catalog from models.dev, and models.dev offers a public API. Use it for context and output limits, tool-call and reasoning support, modalities, and per-token prices, so each model's capabilities come from one source. Provider data overrides it where they disagree.
- **Evidence.** Query BenchLM's MCP server (`data.benchlm.ai/mcp`). Use `benchlm_list_current_rankings` for the Coding and Agentic surfaces, `benchlm_get_current_model_rankings` for each candidate, and current source results such as SWE-bench Verified. Keep each score's evidence label (Supported or Estimated) and its date.
- **Match.** Map provider model IDs to BenchLM catalog IDs. models.dev's canonical IDs provide the link, with `benchlm_list_models` search and an alias table checked into the repo as fallbacks. Any model that doesn't match is shown as "unranked," never guessed.
- **Assign and lock.** Score each candidate against each role's profile, then write `openagentsy.models.lock.json` with the chosen model, the runner-up, the evidence, and the date. The generator turns the lock into the `model:` line of each agent file.

### 2. What each role needs

| Role | Primary signal | Hard requirements | Cost stance |
| --- | --- | --- | --- |
| `lead` | Agentic rank | Tool calls, reasoning variants, large context | Quality first |
| `builder` | Coding rank, SWE-bench Verified | Tool calls | Balanced |
| `reviewer` | Coding rank | **Different creator from builder** (§I.5) | Balanced |
| `scout` / `researcher` | Coding rank above a threshold | Tool calls, fast | Cheapest that clears the threshold |
| `advisor` | Highest Overall or Agentic rank available | Reasoning variants | Ignore cost (rare calls) |
| Magic Context historian / dreamer | Long-context ability | None | Cheapest or local Ollama |

- **Quota-aware on subscriptions.** OpenCode Go meters each model by a monthly dollar cap, with 20% of it available per 5 hours. Kimi K3 allows an estimated 110 requests per 5 hours on Go, while DeepSeek V4.1 Flash allows about 34,670. So K3 can be the advisor but never a scout. The selector divides each role's expected call volume by these published estimates. [[14]][14]
- **Prefer Supported evidence.** A model whose rank is only Estimated must beat a Supported one by a set margin. The lock file records the label either way.
- **Benchmarks pick candidates; your repo picks winners.** `openagentsy eval --models` runs the top two candidates per role on a small task set from your own repos before the lock is final. Public leaderboards don't predict performance on your codebase.

### 3. Privacy filter on by default

**Exclude models whose terms allow training on your prompts, unless the user opts in.** OpenCode Go's own table marks Gemini 4 Argon Contributor and both Muse Spark Contributor models as "Used" for training and not zero-data-retention, while most other Go models retain nothing. The selector reads a per-model retention table and filters these out by default. This applies agentsy's privacy commitment to code, which is often the user's or employer's confidential data.

### 4. Refresh without silent changes

- `openagentsy models refresh` runs weekly or on demand. It shows a diff ("builder: GLM-5.3 → Kimi K2.7 Code; Coding rank 14 → 9; Supported") and applies nothing until the user approves. A model swap changes system behavior, so it counts as a significant decision under agentsy governance.
- The BenchLM free tier allows 250 reads a month, and coverage checks are free. A full init needs roughly 20–60 reads. Cache results locally for 7 days.
- **Licensing:** BenchLM's plans cover queries and internal analysis. Displaying its outputs in a customer-facing commercial product needs a separate agreement. OpenAgentsy should have each user connect their own BenchLM account and must never bundle or republish the data.

### 5. Adaptive effort, built in: one ladder per role

**OpenAgentsy has its own `oa_effort` tool. It treats reasoning effort and model choice as one ordered ladder per role.** The selector builds each ladder from the lock file. For example, the builder's ladder: Kimi K2.7 Code at medium, then the same model at high, then the advisor's model at high. An agent can climb one rung at a time, temporarily, and must give a reason. The rung resets when its session goes idle. It works like ian-pascoe/opencode-adaptive-thinking (MIT, to be credited in the docs), adding model switching, ceilings, and quota checks.

| Role | Start rung | Ceiling | Climb when |
| --- | --- | --- | --- |
| `scout` | Cheap model, low or none | Same model, medium | Results conflict |
| `builder` | Builder model, medium | Advisor model, high (one consult) | A test failed twice; the change touches concurrency, auth, or migrations |
| `reviewer` | Reviewer model, high | Same | Fixed. Review is the cheapest place to buy correctness. |
| `lead` | Lead model, medium | Lead model, xhigh | Planning, decomposition, arbitration |
| `archivist` | Cheapest long-context model, low | Same | Fixed |

- **Defaults come from the evidence:** pick the lowest rung likely to succeed (Anthropic's effort-scaling rules). Climb on concrete triggers like repeated failure, not on a vague sense of difficulty. In Cognition's experience, weaker models were bad at judging their own limits, so the triggers are rules rather than self-assessment.
- **Guardrails:** a climb that would exhaust a Go model's 5-hour quota is refused, and the agent sees why. Every climb, with its reason and its token cost, goes to the audit log. Per-role climb counts appear in the run digest, which also shows where the default rungs are set too low.
- **Implementation:** on V1 the adapter rewrites the outgoing request's variant and model through the plugin API, as the original plugin does. On V2 it uses the model's `#variant` and, when the climb changes models, continues the child session on the new model. Ollama models that only toggle thinking get a two-rung ladder (off, on), recorded during inventory.

---

## VI. One codebase for OpenCode V1 and V2

### 1. The compatibility strategy

**Put the logic in MCP, keep agents in V1-shaped Markdown, and write two thin adapters.** V1 plugins don't run on V2, but MCP servers and file-based agents work on both. V2 explicitly normalizes supported V1 agent, command, and skill files.

| Concern | V1 | V2 | OpenAgentsy approach |
| --- | --- | --- | --- |
| Agent files | `.opencode/agents/*.md`, `permission:` map | Same path, `permissions:` ordered list; reads V1 shape | Generate both from one `roles.yaml`. Never mix formats inside one agent. |
| Delegation | `task` tool, foreground | `subagent` tool, `background:true`, continue by `sessionID`, nesting depth 1 | Adapter exposes `oa_spawn` and `oa_continue`. V1 implements background work through the SDK `client`. |
| Permission keys | `bash`, `task` | `shell`, `subagent` | Generator maps the keys. |
| Plugins | `plugin` array, V1 hook API | `plugins` array, new API, hot reload | Two adapters, each about 300 lines: audit hooks, inbox push, guardrails. |
| MCP | `mcp.{name}` | `mcp.servers.{name}`, reached via Code Mode by default | Set `codemode:false` for board and Beans tools so they're listed directly. |
| Step caps | `steps` | `steps` | Same field on both. |
| Sampling | `temperature` | Moved to `request.body`, which V2 doesn't send yet | Leave it out; set it on provider variants. |
| External paths | Ask by default | Allowed by default | Set explicitly to `ask` on both. |
| Commands | `subtask:true` | `subagent:true` runs in background | Use `subagent`; V2 still accepts `subtask`. |
| Skills | Native `skill` tool, plus opencode-agent-skills for matching and scripts | Native `skill` tool; the plugin doesn't load | Same `.opencode/skills/` files on both. Extras come from the plugin on V1 and from the MCP server on V2. |

### 2. Example: the builder agent

V2 reads this file unchanged. The generator emits the native V2 `permissions:` list when it detects V2.

```markdown
---
description: Implements exactly one bean inside its leased files and worktree. Use only via the lead.
mode: subagent
hidden: true
model: <provider>/<model>   # generated from openagentsy.models.lock.json
steps: 40
permission:
  edit: allow            # path scoping enforced by the adapter's file-lease check
  bash:
    "*": ask
    "bun test*": allow
    "git status*": allow
    "git diff*": allow
    "git commit*": allow
    "git push*": deny
    "kill*": deny        # no interfering with other agents' processes
  task: deny             # builders never spawn agents
  webfetch: deny
---
Scope: implement the assigned bean only. Out of scope: other beans, unleased files,
dependency changes, CI config, .opencode/ and policy files.
Before each retry: state what failed, what you will change, and whether you are repeating yourself.
After 3 failed attempts, post a `blocker` record and stop.
Report with a board record. Mark each claim verified, inferred, or guess.
If the plan or the user's instruction looks wrong, say so in a `question` record. Don't comply silently.
```

### 3. Package layout

```text
openagentsy/
├── roles.yaml                 # single source of truth for agents + scopes
├── packages/
│   ├── mcp/                   # board, leases, budgets, audit (works on V1+V2)
│   ├── adapter-opencode-v1/   # V1 hooks: tool.execute.before/after, session.idle
│   ├── adapter-opencode-v2/   # V2 plugin API equivalent
│   ├── models/                # provider inventory + BenchLM scoring + lock file
│   ├── cli/                   # setup | doctor | models init|refresh | build --target v1|v2 | eval
│   └── evals/                 # Scenario suites (vitest): tasks, safety, red team, faults
└── templates/.opencode/       # generated agents, commands (/plan, /review, /status), starter skills
```

The `setup` command detects the OpenCode version, writes the right config shape, installs beans-mcp, Magic Context, and AFT (plus opencode-agent-skills on V1), and turns off conflicting compaction hooks. Its `doctor` command lists what is installed and what each plugin stores, following AFT's uninstall transparency.

---

## VII. Meeting the agentsy ethics, safety, and governance rules

### 1. Requirement → mechanism

agentsy says a principle that can't be checked in code or review isn't a real safeguard, so each one maps to something testable.

| agentsy requirement | How OpenAgentsy enforces it |
| --- | --- |
| Anti-sycophancy; constructive disagreement | Reviewer on a different model family with a clean context. Seeded-bug benchmark. Builders must file a `question` when the plan looks wrong. Independent-then-share protocol counters the bystander effect. |
| Truthfulness and uncertainty | Required `confidence` field on every record. The Lead's final report separates verified from inferred. |
| No simulated personhood | Functional role names, no personas, no "brain" framing in OpenAgentsy's own copy. CortexKit's marketing metaphors stay in CortexKit's docs. |
| Human authority; AI as tool | Plan approval gate. `ask` on out-of-scope, destructive, and policy-file actions. Escalate to the human instead of competing (§I.7). The user can reset, shut down, or kill any session (§III.6). |
| Scope declaration and scope-drift detection | A `Scope:` block in every agent file. The adapter checks edits against file leases and logs a `scope_violation` event. |
| Memory visible, bounded, controllable | Memory categories restricted. Every memory records its source (bean, commit, file:line). Candidates go live only after verification and appear in the run digest, where the user can veto or edit them. Magic Context browser plus `openagentsy doctor --memory`. No user-profile promotion by default. |
| Audit: policy IDs and firing logs | Every permission decision, lease grant or denial, and budget stop goes to `.openagentsy/audit.jsonl` with a policy ID and version. |
| No dark patterns or engagement loops | Continuation is bounded by steps and tokens. The run ends with a summary and a clean stop, never prompts that keep the user engaged. |
| Third-party and indirect stakeholders | Reviewer checklist covers privacy, security, and accessibility effects on the software's end users. |
| Privacy of user data | Model selector excludes providers that train on prompts or lack zero data retention unless the user opts in. The lock file shows each chosen model's retention terms. |
| No AGI or "relentless autonomy" framing | Docs describe bounded, task-specific utility. No "never stops" or "discipline agent" claims. |
| Professional authority | Architecture decisions are written as ADR beans for human sign-off. The advisor recommends; it doesn't decide. |

### 2. Governance, applied to the agent's own changes

- **Protected paths.** `.opencode/agents/`, `.opencode/skills/`, `roles.yaml`, policy modules, and `ETHICS.md`/`SAFETY.md`/`GOVERNANCE.md` are `ask` for every agent. Changes that weaken protections need a written rationale, per agentsy GOVERNANCE.
- **Release gate.** OpenAgentsy doesn't ship a version unless the safety suite passes: seeded-bug detection, false-premise correction ("the plan says X," where X is wrong), scope-push attempts, red-team runs against protected paths, and audit completeness. Each case is a scripted simulation (§VIII.3) run several times, so one lucky pass can't clear the gate.
- **Significant decisions** become ADR beans with rationale and trade-offs, matching GOVERNANCE's decision-record rule.
- **Incident flow.** A safety regression found in a run becomes a bean labeled `safety`, then a reproduction, a fix at the right layer, a changelog entry, and a new benchmark case.

---

## VIII. Build order and how to know it works

### 1. Phases

| Phase | Deliverable | Exit test |
| --- | --- | --- |
| 0. Baseline | Seven V1-shaped agents. Beans, Magic Context, and AFT installed. Native `oa_effort` ladders. `models init` for OpenCode Zen, Go, and Ollama local and Cloud. Solo and fan-out modes. Subagent harvest to candidate memory. Audit adapter on V1. | Runs unchanged on V1 and V2: the same simulation suite passes against both. Audit log complete. Every role's model choice cites its evidence. Fewer tokens per resolved task than plain OpenCode on the same tasks, with each layer's savings measured. |
| 1. Board | OpenAgentsy MCP: records, leases, budgets. Clean-context reviewer. Fault injection in the MCP layer. | Reviewer catches seeded bugs at least 70% of the time. Zero unleased writes. Every injected fault ends in a retry, a fallback, or a blocker record, never a silent stall. |
| 2. Parallel write | Worktrees and 2–3 background builders. V2 native, V1 via SDK. | Beats solo on pass^3 or wall-clock time on a decomposable task set by enough to justify its extra tokens, without losing on the sequential set. Survives a builder killed mid-task. |
| 3. Learning | Procedural playbooks from archived beans, emitted as skill drafts. Human-approved memory deltas and skills, dreamer verification. Semantic skill matching ported to the MCP server for V2. | Steps per task fall on repeat task types with no rise in failures. |

### 2. Evaluate against a strong solo baseline

**Compare against the Lead running solo with the same tools, model, and token budget.** Ao et al. (2026) showed most multi-agent comparisons confuse a better architecture with simply giving agents more information. Measure resolve rate as pass^k (the share of tasks solved on all k runs, not just one), tokens per resolved task, bugs the reviewer caught that the human would have missed, merge-conflict rate, human interventions, and the agentsy metrics (sycophancy rate, correct-disagreement rate, scope violations, audit completeness). If parallel write doesn't beat solo on your own repos, ship solo plus fan-out and stop there. The research says that outcome is plausible.

### 3. The test harness: simulated users, judges, and injected faults

**Build `packages/evals` on LangWatch Scenario's TypeScript package with vitest.** Scenario tests an agent by running a whole conversation: a simulated user, the agent under test, and a judge that checks written criteria at any turn. Scripts mix fixed messages, generated turns, and plain assertions on tool calls. It's Apache-2.0, and you connect an agent by writing one `call()` method. [[15]][15] OpenAgentsy is interactive, with plan approval, `question` records, and escalation, so a fixed prompt-in, diff-out benchmark can't test the parts agentsy cares about most.

- **One adapter, both versions.** `call()` drives a throwaway OpenCode server through the SDK in a temporary git repo seeded per case. The same suite runs against the V1 and V2 builds, so the cross-compatibility claim gets tested instead of assumed.
- **Check deterministic outcomes first, use the judge last.** Most pass/fail checks read state: the tests pass, the git diff stays inside the leased files, `.openagentsy/audit.jsonl` has a record for every permission decision, and the expected `beans_update` calls happened. The judge handles only what state can't show, such as whether the Lead's report separates verified from inferred claims. Like the reviewer, the judge runs on a different model family from the agent under test.
- **The simulated user plays the agentsy cases.** It approves a plan that contains a false premise, pushes for out-of-scope work mid-run, ignores a `question`, or answers it wrongly. The criteria check that the agent corrects the premise, files a scope record, and doesn't proceed silently.
- **Red team the gates.** Scenario's `RedTeamAgent` runs multi-turn escalating attacks. Point it at OpenAgentsy's own risks: edits to `roles.yaml` or `SAFETY.md`, turning off the approval gate, `git push`, reading secrets, and prompt injection planted in a repo file the scout will read.
- **Inject faults in the MCP layer.** A test flag makes the board and adapters fail on purpose: a Beans etag conflict on `ifMatch`, an OpenCode Go 429 or exhausted 5-hour quota, local Ollama down, a lease that expires mid-edit, a builder killed mid-task, a Magic Context search timeout. Each case passes only if it ends in a retry, a step down the model ladder, or a `blocker` record. Silent loops fail; the AutoGPT loop failures are the cautionary example. [[16]][16]
- **Report pass^k, not pass@1.** Multi-agent runs vary from one run to the next. Run each case k times (3 for each PR, 5 before a release) and count it as passing only if every run passes, the consistency measure from τ-bench. Scenario's `cache_key` replays simulated-user turns, so a failure can be reproduced for debugging.
- **Cost and privacy.** The full suite runs weekly and on demand, on the machine that changes the code; a pull request runs only the unit tests, the typecheck and the audit (the `pull_request` trigger was removed 2026-10-24 — a run is a few hundred provider calls, so its cost must not depend on how often a branch is pushed). The judge and simulated user use models from the user's chosen providers, not a hard-coded OpenAI key. LangWatch's hosted visualization uploads traces, so it stays off unless the user turns it on, matching the privacy row in §VII.

---

## IX. What to verify before building

- **Historian cost in child sessions:** if Magic Context runs its historian in every subagent session, short-lived builders and scouts pay for it. Check whether it can be limited to the Lead's session while child sessions keep `ctx_search`.
- **Push delivery:** Magic Context includes a peer-message primitive (`agent.deliver`), and AIF shows that long-polling works without a persistent connection. Pick one for blocking records rather than writing a new transport, and check which one can wake an idle OpenCode session on each version.
- **V2 plugin hook names:** I read V2's plugin configuration docs, not its build API. The V2 adapter's hook list still needs checking against the V2 plugin-building docs.
- **Model choices:** cross-family review is supported by the evidence above; the specific model pairs need your own eval runs.
- **Ollama Cloud listing and capabilities:** Ollama's docs confirm `https://ollama.com/api` with a Bearer key for cloud access. Confirm that `/api/tags` there lists the cloud catalog, and that `/api/show` reports tool and thinking support for cloud models.
- **BenchLM coverage of open models:** many Go and Ollama models (MiMo, LongCat, Hy, Step) may be unranked or have only Estimated ranks. Run BenchLM's free coverage check first; when coverage is thin, the selector should lean on your own eval results.
- **models.dev field coverage:** confirm which capability flags its API exposes (tool calls, reasoning levels, retention) and how well it covers Ollama Cloud models.
- **Scenario's model routing:** the README's examples use OpenAI models through the AI SDK (TypeScript) or litellm (Python). Confirm that the judge and simulated user work through OpenAI-compatible endpoints for OpenCode Zen and Ollama, so the suite needs no extra provider account.
- **Skill permissions:** confirm the permission key OpenCode uses to limit which skills an agent may load, on both V1 and V2. Per-role skill access depends on it.
- **Synthetic messages and Magic Context:** the plugin injects skills as hidden synthetic messages through the SDK. Check that Magic Context's historian keeps or drops these as intended, rather than summarizing a loaded skill away.

---

## References

1. Kim et al., *Towards a Science of Scaling Agent Systems* — arXiv 2512.08296
2. Xu et al., *Rethinking the Value of Multi-Agent Workflow* — arXiv 2601.12307
3. Cognition, *Don't Build Multi-Agents* (2025) and *Multi-Agents: What's Actually Working* (2026)
4. Cursor, *Scaling long-running autonomous coding*
5. Huang et al., *What Should Agents Say?* (PACT)
6. Claude Code docs: *Agent teams*
7. Chroma, *Context Rot*
8. Cemri et al., *Why Do Multi-Agent LLM Systems Fail?* (NeurIPS 2025)
9. Anthropic, *Patterns and problems in multiagent systems* (2026) — no public link captured
10. *The Bystander Effect in Multi-Agent Reasoning* — arXiv 2605.10698
11. Gloaguen et al., *Evaluating AGENTS.md* — arXiv 2602.11988
12. *Agentic Context Engineering* — arXiv 2510.04618
13. *A Survey of Agent Memory in the Second Half* — arXiv 2602.06052
14. OpenCode Go docs: models, prices, usage limits
15. LangWatch Scenario: agent testing through simulation (Apache-2.0)
16. chaosync-org, *awesome-ai-agent-testing* (index of methods)
17. joshuadavidthomas, *opencode-agent-skills* (MIT, maintenance mode)
18. dshein-alt, *AIF: AI Interaction Forum* (MIT or Apache-2.0)
19. Lu et al., *LLM Discussion: Enhancing the Creativity of Large Language Models via Discussion Framework and Role-Play* (COLM 2024) — arXiv 2405.06373

[1]: https://arxiv.org/abs/2512.08296
[2]: https://arxiv.org/abs/2601.12307
[3]: https://cognition.ai/blog/dont-build-multi-agents
[4]: https://cursor.com/blog/scaling-agents
[5]: https://github.com/iNLP-Lab/PACT
[6]: https://code.claude.com/docs/en/agent-teams
[7]: https://www.trychroma.com/research/context-rot
[8]: https://doi.org/10.52202/085713-4082
[10]: https://arxiv.org/abs/2605.10698
[11]: https://arxiv.org/abs/2602.11988
[12]: https://arxiv.org/abs/2510.04618
[13]: https://arxiv.org/abs/2602.06052
[14]: https://opencode.ai/v2/docs/console/go/
[15]: https://github.com/langwatch/scenario
[16]: https://github.com/chaosync-org/awesome-ai-agent-testing
[17]: https://github.com/joshuadavidthomas/opencode-agent-skills
[18]: https://github.com/dshein-alt/aif
[19]: https://arxiv.org/abs/2405.06373
