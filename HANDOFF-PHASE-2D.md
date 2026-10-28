# Handoff — phase 2b and 2c are done; 2d is next

Written 2026-10-27 by the Lead of the phase-2 run. `develop` is at `40e0f08`
(pushed). `main` is at `f3fe848` and is the release branch — do not merge
phase work into it.

## What is landed

| Step | Landed | State |
|---|---|---|
| **2a** | `defineTool`, the `tasks` package, the `memory` slice, `footprint`, the doctor's config map | merged, pushed |
| **2b** | `ledger` (ingest, pricing, waste, outcomes), `offload` (router, breaker, replica modes), the budget reconciliation | merged, pushed |
| **2c** | `@openagentsy/hooks` (the rule registry, the seven rules, the output checks, the shell env policy, the approval gate, the lessons and their eval runner), the OpenCode bridge, the recovery loop's board rules, the doctor's regeneration diff, `/oa approve` | merged, pushed |

Thirteen packages, 1106 unit tests, `bun run check` green, the fallow audit
passes with 0 introduced. The safety suite is the gate that is still
running — see below.

## The next step: 2d, `quality`

The plan's row (plans/PHASE-2-PLAN.md, section 15): the quality registry,
the static rules, the comment lint, the sloplint bridge, the waivers, the
three skills, the reviewer gate. Its exit list is seven items, the ones
worth quoting:

- each static rule has a passing and a failing fixture;
- a comment fix leaves the AST identical apart from comments, and never
  removes a comment on the preserve list;
- a task with an open floor finding cannot be completed;
- an agent cannot record a waiver (map + hook, both directions), and a
  floor rule cannot be waived;
- a "ship" verdict with an open floor finding is rejected as
  `fabricated-pass`;
- sloplint runs without `TOGETHER_API_KEY` and degrades cleanly when
  Hallmark is absent;
- no quality skill loads when no UI, copy or comment file is touched (a
  token test).

Two things to settle while planning it: sloplint and Hallmark are external
tools (both are on this machine, so the bridge can be real rather than a
stub), and the token test means the skill selection has to be measurable,
not a convention.

Then **2e** (`sidebar` V2, the worktree shared state of section 3.9, `oa
conformance`, `oa report --ethical`) and **2f** (revision 3's eight new
sections: the ethics framework, the safety benchmark suite, incident
response, privacy and bounded personalization, the policy module library,
scope declarations, the credential broker, the sandbox for untrusted code —
plus the items 2a deferred: checkpoints, the memory commands, the
fingerprint, the WAL).

## Open items the next session inherits

1. **The safety suite on the 2c tree.** It was running when this handoff
   was written (`/tmp/suite-2c.log`). The red team case is the one to watch:
   it has been red for two runs on a 30-minute turn timeout, and 2c is
   exactly what should stop it. If it is still red, the case's own turn
   budget is the first thing to look at, not the rules.
2. **The state root (plan 3.9) is not landed.** The CLI resolves it as
   `--root ?? cwd`, so `oa approve` run from a worktree writes
   `approvals.json` into that worktree instead of the main root the plugin
   reads. 2e owns 3.9; until then, run the approval command from the main
   checkout.
3. **The approval store's crash window.** The grant is written and the
   audit line is written after it, so a process death between the two
   leaves a grant on disk that no audit line records. The grant expires in a
   day, and the review that found it called the bean `ship`, so it was left
   as it is.
4. **The disk.** `~/.local/share/opencode/opencode.db` is 13.9 GB on a
   volume at 93% (67 GB free). The safety suite's isolated case runs are
   the growth. It holds this session's own data, so pruning it is the
   person's call, not the agent's.
5. **The spawn-tool catch-all stays `**`.** Upstream fixed the plugin in
   0.49.24 (cortexkit/magic-context#777), but the double asterisk behaves
   identically under both the fixed and the unfixed plugin, and an agent
   that loses its Task tool cannot dispatch anything at all. The comment in
   packages/core/src/permissions.ts says so, and says what changing it
   back costs (a server restart and a dispatch that works, in that order).

## Traps this phase paid for

- **A lease glob has to be absolute for a worktree.** The guard makes a
  write path relative to the SESSION ROOT, and a child session is rooted at
  the main repo, so a write inside `/tmp/oa-wt-...` resolves to an absolute
  path. A relative glob never matches it, and a Lead-held umbrella lease on
  the worktree outranks the builder's own globs. Grant each builder
  `/tmp/oa-wt-<bean>/**` and hold nothing there yourself.
- **The fault injection must target the child by its parent id.** OpenCode
  names a session from the task description AFTER the dispatch returns, so a
  child that works fast finishes before its title exists, and an untitled
  session comes back with `title: ''`, not `undefined`. The watch must also
  live until the harness stops it: a 60-second poll cap expired before a
  slow Lead dispatched (123 s), so the fault silently did not land — and a
  case that tests a fault it did not inject passes every other check.
- **The suite's own run must not be piped.** `| tail -N` ate the verbose
  FAIL block twice; redirect to a file instead. A COMPLETED run removes its
  database and server log; only a KILLED run leaves them, and the kept case
  directories are the only way back to a lost verdict.
- **A git command that inherits `GIT_DIR` re-initialises the outer
  repository** and sets `core.bare = true` on it, which breaks `git status`
  everywhere. The harness now strips the git variables for the server, the
  case seeding and the tests, and runs the server in its own directory. If
  `git status` starts failing with "this operation must be run in a work
  tree", the config was rewritten: `git config --unset-all core.bare` in the
  affected repo, and check that no local `[user]`/`[commit]` block shadows
  the global identity.
- **GitHub push protection flags synthetic secret fixtures.** A fake Slack
  token in a test file is a scanner hit, and the flag lives in the history,
  so the whole ancestry has to be rebuilt before the push. Fixtures are
  assembled from segments instead.
- **A plugin is a copy.** `.opencode/plugins/openagentsy.js` is what
  OpenCode loads; after changing the adapter, run
  `bun packages/cli/scripts/copy-plugin.mjs` or the plugin-bundle test
  fails against a stale copy.
- **The OpenCode server caches the agent definitions**, so a child keeps the
  model id that was in the agent file when the server started. Dispatch a
  child with an explicit model until the server is restarted.
