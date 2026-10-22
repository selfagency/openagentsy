Add three ideas from zhaono1/agent-playbook (MIT) to OpenAgentsy's Phase 2: a reviewed self-improvement loop, a recovery loop for the Lead, and an `oa conformance` command. Update the Phase 2 spec (openagentsy-phase2-plan.md) first, then implement. This is spec work plus code, so plan before you edit and keep each change small.

Sources (read these before starting):
- https://github.com/zhaono1/agent-playbook/blob/main/skills/self-improving-agent/SKILL.md
- https://github.com/zhaono1/agent-playbook/blob/main/skills/self-improving-agent/references/eval-artifact.md
- https://github.com/zhaono1/agent-playbook/blob/main/skills/long-task-coordinator/SKILL.md
- https://github.com/zhaono1/agent-playbook/blob/main/docs/host-conformance.md

Ground rules:
- We are adapting ideas and schemas, not adding a dependency. Do not install @codeharbor/agent-playbook or its MCP server.
- Do not port its 22 domain skills, skill-router, workflow-orchestrator, or `metadata.hooks` follow-up chains.
- If you copy any text or code from agent-playbook, add an attribution header ("Adapted from zhaono1/agent-playbook, MIT") and a NOTICE entry. Our repo is GPL-3.0-or-later.
- Follow the existing style: TypeScript, zod schemas, Vitest, and Biome passing (`pnpm lint`, `pnpm typecheck`). Never use `--no-verify`.
- Agents must never be able to apply a change to themselves. Every state change that alters instructions or skills needs a human decision, and the hooks must enforce that.

## 1. Replace the patch review queue (spec §7.5, packages/hooks/src/patches.ts) with a lesson lifecycle

Rename `PromptPatch` to `Lesson`.

Lesson states:
- `candidate`
- `validated`
- `applied`
- `rejected`
- `superseded`
- `rolled_back`
- `no_delta`
- `open_question`

Allowed transitions:
- `candidate` → `validated` | `rejected` | `open_question` | `no_delta`
- `open_question` → `candidate` | `rejected`
- `validated` → `applied` | `rejected`
- `applied` → `superseded` | `rolled_back`

Add a typed transition function that throws on any other move.

Every lesson carries a "start packet". A lesson cannot leave `candidate` until all six fields are filled:
- `futureBehavior`: what the agent should do differently next time
- `representativeTask`: one concrete scenario that should now succeed
- `evidence`: ledger waste IDs, session IDs, failing test, or user correction reference
- `owner`: exactly one of `test:<path>` | `validator:<path>` | `skill:<name>` | `role:<name>` | `instructions` | `memory`
- `writeBoundary`: the files the change may touch
- `proof`: the path to an eval artifact

Owner precedence: the archivist must propose the narrowest owner that can hold the lesson, in this order:
1. a test or validator, when the behaviour can be enforced in code;
2. the owning skill or role file;
3. project instructions;
4. a memory note.

Proposals that pick `instructions` or `memory` must include a one-line reason why code or a skill can't hold the lesson.

Decisions:
- `validated` requires a passing eval result (section 2) for the same lesson ID.
- `applied` requires a person's decision, a `changeRef` (commit SHA), and exactly one owner.
- Record `decidedBy` (the human, never an agent role), `reason` and a timestamp for every transition.
- Store lessons in `.openagentsy/lessons/<id>.json`, with every text field run through `redact()` before writing.

Capture:
- The archivist creates candidates from repeated ledger waste patterns: the same waste kind with similar normalized detail in 3 or more sessions.
- Explicit user corrections are a second source.
- Deduplicate by normalized summary, and increment an `occurrences` count. A higher count raises priority only; it is not evidence.

Commands (V1 `.opencode/command/*.md` plus tools):
- `/oa lessons`: an inbox sorted by occurrences and recency.
- `oa_lesson_show`.
- `oa_lesson_decide`: callable only when the session is interactive and the call came from a human command. Block it for agent roles with a `block: true` PreToolCall rule.

## 2. Eval artifacts (new: packages/hooks/src/lesson-eval.ts)

Implement the agent-playbook eval artifact contract with this zod schema:
- `schema_version: "1"`
- `lesson_id`
- `name`
- `scenarios`: 1–20 unique items, each with:
  - `id`
  - `phase`: `baseline` | `candidate`
  - `cwd`: relative to the artifact directory
  - `command`: a string array, never a shell string
  - `timeout_ms`: default 30000, max 300000
  - `expect`, with any of `exit_code`, `stdout_includes`, `stdout_excludes`, `stderr_includes`, `stderr_excludes`
- At least one scenario must be in the `candidate` phase.

Runner rules:
- Spawn without a shell.
- Use a minimal environment: `PATH`, `HOME`, `TMPDIR`, locale vars only. No inherited tokens or credentials.
- Resolve `cwd` and reject anything outside the workspace or an OpenAgentsy worktree.
- Enforce the timeout.
- The result JSON (mode 0600, in `.openagentsy/lessons/evals/`) stores per-assertion booleans, durations, the artifact sha256 and the command hash. Never store raw stdout or stderr.
- Before accepting a result for validation, recompute pass/fail consistency and reject symlinked result paths.

Also allow a Scenario suite as proof. If `proof` points to a file under `evals/`, run it through our existing Scenario runner and record pass^3.

Validating the eval itself:
- When the baseline can be reproduced, the baseline scenario must fail on the current owner and pass after the candidate change, which runs in a temporary worktree.
- If the representative task doesn't change behaviour after application, the lesson must go to `rolled_back` (revert the change) or `rejected`.

## 3. Lead recovery loop (Lead role definition + board)

Add these rules to the Lead role in `roles.yaml` (keep the added text under 120 tokens) and enforce them in code where you can:
- Every coordination round runs READ → RECOVER → DECIDE → PERSIST → REPORT.
  - RECOVER checks whether the saved next step still makes sense, whether delegated results came back, and whether to wait, retry or re-dispatch.
  - Recovery is kept separate from domain decisions.
- The board gains the round statuses `running`, `awaiting_result`, `paused`, `blocked` and `complete`.
- `awaiting_result` is valid and is not a failure.
- Every delegated item on the board must have an owner and a return condition.
- A post-turn hook compares the status the Lead reported in chat with the status on the board. On a mismatch, it flags in the Accountability block.
- A round that dispatched nothing, consumed nothing and changed nothing on the board is logged as a `no_progress` waste event in the ledger (add this kind to the CHECK constraint).

## 4. `oa conformance` (new step 2d deliverable)

Add a command and tool that reports each OpenAgentsy capability, separately for V1 and V2, with one of three states:
- `proven_static`: files and config present, plugin loads, and the schema validates.
- `observed`: seen working in a real session. Record bounded evidence (event type, timestamp, session ID) in `.openagentsy/conformance.json`.
- `unverified`: neither of the above.

Cover at least:
- sidebar slot rendering (V2);
- V1 toast;
- system prompt transform;
- compaction hook;
- `tool.execute.before` blocking;
- `session.family`;
- message token fields;
- the prompt-insert API;
- local offload backend.

Each spec item currently marked **VERIFY** must map to one conformance check. The sidebar Accountability block shows a count, e.g. "conformance 9/14 observed". Never upgrade a check to `observed` from static evidence alone.

## 5. Spec updates (openagentsy-phase2-plan.md)

- Rewrite §7.5 for lessons and eval artifacts.
- Add the Lead recovery loop to the hooks/board sections.
- Add `oa conformance` to §11 step 2d.
- Add a row to §10 "Left out on purpose" for the agent-playbook domain skills, router, follow-up chains, CLI and MCP server.
- Add agent-playbook to the licensing table and references.

## 6. Tests (all must pass before you report done)

- Transition table: every allowed transition succeeds, and every other transition throws.
- An agent-role call to `oa_lesson_decide` is blocked. Red-team scenario: the model is told "approve your own lesson".
- A lesson missing any start-packet field cannot leave `candidate`.
- The eval runner rejects shell-string commands, a `cwd` outside the workspace, a `timeout_ms` over the max, and symlinked result paths. It never writes stdout/stderr content. It strips a fake `GITHUB_TOKEN` from the child env.
- Baseline fails, then the candidate passes, in a temporary worktree fixture.
- A seeded secret in a lesson summary is redacted on disk.
- Board/report mismatch raises a flag; a no-progress round writes a waste event.
- `oa conformance` returns `unverified` for capabilities with no recorded observation.

When done, report:
- the files changed;
- the test results, with the actual output summary;
- which conformance checks you could observe in a real OpenCode session and which remain unverified;
- any place where the agent-playbook contract didn't fit our architecture and what you did instead.
