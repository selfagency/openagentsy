<!-- fallow:agent-install v1 authored sha256=f842539365ad8f83c828f164ce6f4b80213ce7db344260a83f83069f914e5a29 -->
# AGENTS.md

This file gives coding agents project-specific context. Keep it short and update it when workflows change.

## Project Overview

- Primary app or package: a Bun workspace of ten packages, built by Turborepo. `core` holds the role schema, the permission mapping, the board, the fnv1a64 etag and the secret-redaction helpers; `cli` builds the agent files; `mcp` is the board server; `models` picks the model per role; `adapter-opencode` is the lease guard plugin and exports `defineTool`; `jev` is the System One client; `evals` is the safety suite; `tasks` is the Beans-compatible task store with the `oa_task_*` tools and the prime block; `memory` is the memory slice (append-only store, inbox over `bean: memory` board records, human-only decide); `footprint` is the EcoLogits-method energy/water/carbon estimator (ranges only, injected data).
- Main entry points: `packages/cli/src/index.ts`, `packages/mcp/src/index.ts`, `packages/adapter-opencode/src/index.ts`
- Important directories: `packages/*` (the workspace), `roles.yaml` (the role source of truth), `plans/` (PLAN.md, PHASE-2-PLAN.md, REMEDIATION-PLAN.md), `.opencode/context/project-intelligence/` (the patterns an agent should follow), `templates/.opencode/skills/` (the skill sources), `.openagentsy/` (board state, leases, audit log)

## Architecture Notes

- Module boundaries: Bun workspaces (packages/*), tasks ordered by turbo. `core` sits under everything; `adapter-opencode` and `mcp` sit on top of it.
- The board owns the SQLite database at `.openagentsy/board.sqlite`. The plugin opens it directly with `bun:sqlite` (the plugin runtime is Bun), so there is no snapshot file and no staleness window.
- Generated or vendored code: `openagentsy.models.lock.json` comes from `openagentsy models init`, and `.opencode/agents/` comes from `openagentsy build`. Do not hand-edit either. `templates/` is the source of the skills, not a generated directory.
- Sensitive areas: the lease guard in `packages/adapter-opencode` decides who may write. The board cannot verify the caller, so the enforcement is the permission map: `roles.yaml` denies `openagentsy_board_lease_grant` to every role but the Lead, which takes the tool out of the other toolsets entirely. The safety suite in `packages/evals` is what proves the guard holds.

## Commands

- Install: `bun install`
- Build: `bun run build` (turbo; the plugin is bundled by `tsdown`, the rest is `tsc -b`)
- Test: `bun run test` (unit tests only; it builds first, then runs vitest under bun)
- One package: `bunx --bun vitest run packages/core`
- Lint: `bun run lint` (Biome). Fix: `bun run lint:fix`
- Typecheck: `bun run typecheck` (turbo; per package `tsc -b`, no `--noEmit`: a composite project may not disable emit)
- Everything CI runs, whether named `check` or `ci:check`: `bun run check` (Biome, then the typecheck)
- The CLI: `bun packages/cli/dist/index.js build`, or `bun run openagentsy build` after a build

The workspace is plain Bun workspaces with no catalog. If shared version pins are ever needed, they go through the workspaces' own package.json files; the decision to keep a catalog out was made on 2026-10-26.
- The safety suite: `OPENAGENTSY_EVAL=1 bunx --bun vitest run packages/evals`. It is excluded from `bun run test` and takes tens of minutes for the fourteen cases. `OPENAGENTSY_EVAL_MODEL` and `OPENAGENTSY_EVAL_JUDGE_MODEL` pick the models; `OPENAGENTSY_EVAL_CHANGED` names the changed files and the suite runs only the cases that read them; `OPENAGENTSY_EVAL_CONCURRENCY` caps the cases that run at once (five by default); `LANGWATCH_API_KEY` is optional and only uploads the conversations, which cost the workspace's monthly usage. The suite runs on the machine that changes the code, weekly, and on demand. It does **not** run on a pull request: a run is a few hundred provider calls and tens of minutes of runner time, and every push to a branch started one, so the cost of a review depended on how often the branch was pushed. The pull request lane runs the unit tests, the typecheck and the audit, which take under a minute.

## Switching the provider

- `openagentsy models switch <provider...>` re-picks the models for those providers with the selection `models init` uses, writes the lock, and says what else the switch touches. `--yes` writes without asking. `openagentsy models refresh` re-picks with the providers the lock records, so a refresh cannot move the project back to a provider the lock no longer names.
- The switch touches more than the lock. The agent files carry the models, so run `openagentsy build` afterwards. CI takes its model from the lock, so the next suite run uses the new provider.
- The provider needs its key: in the auth store locally (`~/.local/share/opencode/auth.json`) and as a CI secret of the same name — `OPENCODE_API_KEY` for the OpenCode Console and Zen, `OLLAMA_API_KEY` for Ollama Cloud. The alias `ollama` is Ollama Cloud and `ollama-local` is the provider on this machine, which OpenCode cannot run.
- `--prefer-flash` is a flag on the same commands. It takes the flash variant of the family a role would have got, when that variant passes the same hard requirements, and the report shows the rank of both so the cost of the trade is visible.

## Traps

- The plugin runtime is Bun, and `bun:sqlite` works there — proven with a probe on v1 and v2. The adapter opens the board database directly; there is no lease snapshot file. Bare imports still do not resolve in a plugin file, so `adapter-opencode` is bundled by `tsdown`, and its `tsconfig.json` sets `emitDeclarationOnly`: `tsc -b` must never write into `packages/adapter-opencode/dist`, or it replaces the bundle with output that cannot load as a plugin.
- The installed plugin is a copy. `.opencode/plugins/openagentsy.js` is what OpenCode loads, and it does not change when the bundle in `packages/adapter-opencode/dist` is rebuilt. After changing the adapter, copy the new bundle over it, or the session keeps running the old guard.
- The provider key comes from the auth store, not the environment. `~/.local/share/opencode/auth.json` wins over `OPENCODE_API_KEY`, so a local session and a CI job can be on different keys: the CI has no auth store, so it uses the secret. A stale secret does not fail fast — OpenCode waits for an authentication answer that never comes, and every case in a suite run times out at 600s with the cause invisible. Change the secret when the key changes.
- The plugin's `tool.execute.before` hook does **not** fire for MCP tool calls. It fires for the file and shell tools only. So the plugin cannot stamp a session's identity onto a board call, and no board rule may depend on the caller being known.
- The V1 agent permission key is `bash`, not `shell`. OpenCode 1.19.3 drops a `shell` key silently. V1 uses `bash` and `task`; V2 uses `shell` and `subagent`.
- The lease guard blocks a write to any file no lease covers, including a file the agent believes is its own. An agent that needs to write asks the Lead for a lease, or posts a `question` record.
- A lease is only ever released by its holder, through `board_lease` with op=release. There is no other way to free a path.
- The board refuses a lease that would put a fourth writer on the board. The cap is three writers, and it is enforced in the board, not in a prompt.
- The board MCP has no OpenAI compatible endpoint. The judge in the safety suite is another session on the same server with a tool-less agent, not an HTTP call.
- Biome does not format Markdown here (`!**/*.md` in `biome.jsonc`). Its Markdown formatter rewrites the plans, which is churn, not a fix.
- The pre-commit hook runs `lint-staged`, then `tsc -b`, then `fallow audit --base HEAD`. The audit compares the working tree against `HEAD`, so a partial commit is audited against everything that is still uncommitted.

## Fallow

- Use `fallow audit --format json --quiet` before committing AI-generated changes.
- Use `fallow dead-code --format json --quiet`, `fallow dupes --format json --quiet`, and `fallow health --format json --quiet` for targeted checks.
- Use `fallow list --entry-points --format json --quiet` and `fallow list --boundaries --format json --quiet` to inspect project shape.

<!-- generated:task-matrix:start -->
| When the agent is about to... | Run |
|---|---|
| delete an "unused" export or file | `fallow dead-code --trace <file>:<export>` |
| prove a TypeScript symbol's exact consumers before refactoring | `fallow dead-code --type-aware --symbol-impact <file>:<export-or-class.method>` |
| find how one module reaches another | `fallow trace --path <from> <to>` (Reports `reachable: false` instead of failing when no import path exists; type-only hops are reported, not skipped.) |
| delete an "unused" dependency | `fallow dead-code --trace-dependency <name>` |
| migrate a dependency | `fallow trace --dependency <name> --sites` (Counts each imported name, follows one hop through project wrappers, and counts each use that it cannot resolve.) |
| commit or open a PR | `fallow audit --base <ref>` |
| read a diff before approving it | `fallow review --base <ref> --brief` (orientation, never gates: deterministic and always exit 0, unlike the audit row) |
| prioritize refactoring | `fallow health --hotspots --targets` |
| ask who owns code | `fallow health --ownership` |
| check untested-but-reachable code | `fallow health --coverage-gaps` |
| consolidate duplication | `fallow dupes --trace dup:<fingerprint>` |
| find feature flags | `fallow flags` |
| check which architecture rules apply to a file before changing it | `fallow guard <files>` |
| check import cycles, boundaries and policy rules after changing code | `fallow architecture` |
| surface security candidates | `fallow security` |
| understand a finding | `fallow explain <issue-type>` |
| scope a monorepo | `--workspace <glob> / --changed-workspaces <ref>` (global flags, prefix any command) |
<!-- generated:task-matrix:end -->

## Agent Rules

- Do not edit: `templates/`, `openagentsy.models.lock.json`, `.opencode/agents/`, or the fallow-managed blocks in this file.
- Always ask before: widening a role's scope, changing the writer cap, removing a rule from `.fallowrc.json`, or changing the plan in `plans/`.
- Read `.opencode/context/project-intelligence/technical-domain.md` before writing code here. It holds the stack, the patterns, the naming and the rules this codebase follows.
- Preferred style: single quotes, semicolons, two spaces, Biome formatting. No non-null assertions.
- The branch flow is git-flow-next on the classic preset: `develop` is the parent of every topic branch, and `main` is the release parent.

---

<!-- fallow:setup-hooks:start -->
## Fallow checks

Use fallow for code-quality, cleanup, and setup tasks in this repository. Fallow checks the changed code before each `git commit` and `git push`. In Claude Code and Codex, a PreToolUse hook from `fallow agent install` runs this check and blocks the command when the verdict is `fail`. Other agents run the check themselves: `fallow audit --format json --quiet --explain --gate-marker agent`. If the verdict is `fail`, fix the reported findings before you try again. A JSON runtime error such as `{ "error": true, ... }` does not block.

Audit defaults to `gate=new-only`: only findings introduced by the current changeset affect the verdict. Inherited findings on touched files are reported under `attribution` and annotated with `introduced: false`, but do not block the commit. Set `[audit] gate = "all"` in `fallow.toml` to gate every finding in changed files.

For non-skill agents, treat the task map below as the local onboarding source: run the listed fallow command before destructive edits, before commits, and before pull request handoff.

## Fallow task map

| When the agent is about to... | Run |
|---|---|
| delete an "unused" export or file | `fallow dead-code --trace <file>:<export>` |
| prove a TypeScript symbol's exact consumers before refactoring | `fallow dead-code --type-aware --symbol-impact <file>:<export-or-class.method>` |
| find how one module reaches another | `fallow trace --path <from> <to>` (Reports `reachable: false` instead of failing when no import path exists; type-only hops are reported, not skipped.) |
| delete an "unused" dependency | `fallow dead-code --trace-dependency <name>` |
| migrate a dependency | `fallow trace --dependency <name> --sites` (Counts each imported name, follows one hop through project wrappers, and counts each use that it cannot resolve.) |
| commit or open a PR | `fallow audit --base <ref>` |
| read a diff before approving it | `fallow review --base <ref> --brief` (orientation, never gates: deterministic and always exit 0, unlike the audit row) |
| prioritize refactoring | `fallow health --hotspots --targets` |
| ask who owns code | `fallow health --ownership` |
| check untested-but-reachable code | `fallow health --coverage-gaps` |
| consolidate duplication | `fallow dupes --trace dup:<fingerprint>` |
| find feature flags | `fallow flags` |
| check which architecture rules apply to a file before changing it | `fallow guard <files>` |
| check import cycles, boundaries and policy rules after changing code | `fallow architecture` |
| surface security candidates | `fallow security` |
| understand a finding | `fallow explain <issue-type>` |
| scope a monorepo | `--workspace <glob> / --changed-workspaces <ref>` (global flags, prefix any command) |
<!-- fallow:setup-hooks:end -->
