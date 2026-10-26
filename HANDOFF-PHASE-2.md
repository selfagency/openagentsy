# Phase 2 handoff

For the agent taking over after the 2026-10-26 machine-and-release round.
Everything below was verified by running it, not assumed. Where a claim has a
number, the number is one of: a commit hash, a run id, or a file:line.

## Where the project stands at handoff

- `main` = `bf42980`, released as **v0.1.1** with the plugin bundle attached;
  `v0.1.0` was cut the same day. Both live on npm: `openagentsy` and
  `@openagentsy/{core,models,mcp}`. The 0.1.1 packages were published **from
  CI over OIDC trusted publishing** (run 40382198124, four provenance
  statements in the sigstore log), so npm needs no token from anyone, ever.
- `develop` = `096d2c9` merged into main; topic branches merged; the board
  state, lease tables and audit log are clean of stalled sessions.
- Every workflow is **manual-trigger only, by decision of the owner**
  (2026-10-26): a push never cuts a release, never publishes, never runs the
  safety suite. `release.yml` and `publish.yml` take a tag by hand; the
  safety suite runs on the machine that changes the code, weekly, and on
  demand. Do not re-add triggers without being asked.
- The safety suite: 14 cases, `describe.concurrent` behind
  `OPENAGENTSY_EVAL_CONCURRENCY` (default 5), trials budget 1,800,000 ms per
  trial. On Ollama Cloud it takes 10–30 min and currently shows 10–12 of 14
  green per run, with the residual reds being provider stalls (a case burns
  its full budget when the stream dies) and honest judge variance, not fixed
  defects. Every fixed defect that week was closed with a regression test
  carrying the real record text that triggered it — keep doing that.

## The build order (what to actually work on)

The work order is `plans/PHASE-2-PLAN.md`, extended by
`plans/PHASE-2-PLAN-REVISION3.md` (a delta doc; the banner on the main plan
points at it). Step **2.0r** is done — the residue landed on 2026-10-26
(commit `2c47fe0` plus the release rounds): the `packageManager` pin and
`.bun-version`, the `check` alias, `CONTRIBUTING.md`, the `oa` bin alias,
`check.yml` reconciled to turbo lint/typecheck/test/build with frozen
lockfile, the release and publish workflows, the catalog decision recorded
in AGENTS.md (plain workspaces, no catalog), and the 0.1.0/0.1.1 releases.

What remains, in order, each standing on the last:

1. **2a** — `defineTool` extraction from the MCP server (no `defineTool`
   symbol exists today: green field), a `tasks` package with prime, the
   memory slice, `footprint`, and the doctor config-map. The plan defines
   each tool's contract and the doctor's checks; read those sections before
   writing anything.
2. **2b** — `ledger` (ingest, pricing, waste, outcomes), `offload`, budget
   reconciliation.
3. **2c** — `hooks`: the bridge, rules, redaction, output checks, lessons +
   eval runner, the Lead recovery loop, PROTECTED, `/oa approve`.
4. **2d** — `quality` package: static rules with passing and failing
   fixtures; a comment fix must never alter the AST beyond comments.
5. **2e** — `sidebar` (V2 blocks with V1 fallback), worktrees (3.8/3.9),
   `oa conformance`, `oa report --ethical`.
6. **2f** — the ethics/safety/governance docs, the 12-category benchmark
   suite, `oa release-check`, the incident runbook. Plan lines 1063–1092
   hold its exit tests.

Parked, independent of the chain: **J-O1** (V2 harvest proof on a real
OpenCode 2 session) and **J-O2** (the System One guardrail, deferred until a
failure-mode decision exists). Also stale and worth deleting in a docs
sweep: the Beans-via-mcp and Magic-Context-wiring items in `PLAN.md` IV, and
the "smoke set on PR" item in `PLAN.md` VIII.3 — all superseded by behavior
already in the repo (the board, the memory bean, the weekly suite).

## How to run the things you will need

```sh
# everything CI runs
bun run check

# the safety suite (never in CI on a push; ~10–30 min; no traces by default)
env -u LANGWATCH_API_KEY OPENAGENTSY_EVAL=1 \
  OPENAGENTSY_EVAL_MODEL=ollama-cloud/minimax-m3.1-flash \
  OPENAGENTSY_EVAL_JUDGE_MODEL=ollama-cloud/deepseek-v4.1-flash \
  OPENAGENTSY_EVAL_TRIALS=1 \
  bunx --bun vitest run --reporter=verbose packages/evals

# keep the case directories after a run, to read the board a verdict judged
#   add: OPENAGENTSY_EVAL_KEEP=1
# the board sits in the case dir at .openagentsy/board.sqlite; read the
# records table before believing any failure message.

# release (manual, by decision); main carries it
gh workflow run release.yml --ref main -f tag=v0.1.2   # bumps the versions first
gh workflow run publish.yml --ref main -f tag=v0.1.2   # after release.yml is green

# the OTP for any hand-run npm command
op item get Npmjs --otp
```

## The traps that cost this round the most — read before working

1. **Cross-package dependencies use `workspace:^`** (`096d2c9`). Plain
   semver ranges make a clean clone ask the registry for workspace members
   and 404 — this killed a release run. At publish time npm rewrites
   `workspace:^` for consumers.
2. **npm never runs inside the repository tree.** The root `devEngines`
   names bun; npm 11.13 refuses every `failOn` spelling. Everything npm —
   pack, publish, `npm view` — runs from a directory outside the repo, e.g.
   `/tmp/npm-neutral`, against a package path or tarball. `publish.yml`
   copies packages to `$RUNNER_TEMP` for the same reason.
3. **The release guard checks the root manifest**; the publish guard checks
   the four packages. Bump all five (root + 4) or the tag check fails before
   anything else happens, which is correct and recoverable.
4. **Merges eat the model lock.** The `openagentsy.models.lock.json` switch
   to Ollama was silently lost in a PR merge once; after any merge, verify
   the lock's `providers` before dispatching anything. If a provider's
   answer stops working after a merge, suspect the lock first.
5. **The OpenCode server caches agent files at start.** After switching
   providers or editing agent files, restart the app before trusting the
   task tool to use them. Headless fallback:
   `opencode run --model <provider/model> --auto "brief"` — grants leases to
   `OpenCoder` (the identity such sessions run as), never to a role id.
6. **Dispatch briefs must be self-contained.** A dispatched session returns
   only its last text; evidence lives in board records the brief tells the
   child to post (`from` = the role's agent id, `bean`, `kind status`,
   real gate output). Builders hit their step budget before posting records
   otherwise.
7. **Stale leases block grants.** `board_lease_revoke` (the Lead only) is
   the fix; the janitor still does not prune the lease table, so dead
   sessions hold their files until revoked by hand.
8. **Commits are signed through the 1Password SSH agent.** If it answers
   with `fatal: failed to write commit object`, the fix is the agent (ask
   the person to unlock); interim: `--no-gpg-sign`, then
   `git commit --amend --no-edit` + `push --force-with-lease` once it's
   back. There are no unsigned commits on main and there should stay.
9. **After switching branches, run `bun run build` before committing** — the
   gitignored plugin copy (`packages/cli/plugin/openagentsy.js`) and the
   pre-commit hook compare against the fresh bundle, and a stale copy fails
   the build late. Install once with `--frozen-lockfile` in any fresh
   worktree.
10. **The judge reads denials by absence** (judge template, `30f8bbe`) —
    criteria phrased as "did not claim X" are met when X never happened.
    The false-premise check fails only on the pair (covered AND returns
    10). Builder completion records state the artifact, never the word
    done; the Lead-name check reads both `lead` and `agentsy`. If a new
    eval case fails an agent that seemed right, read the kept board before
    touching the check.

## The round this handoff closes

Dispatch fix (`8afd075`), role shell maps (`f7e95d3`), eval fixes and PR #3,
the janitor and PR #4, the Ollama lock restored after the merge casualty
(`67ae652`), the judge/regex corrections (`30f8bbe`), the artifact
confirmation (`be715be`), the archivist standing free of its parent
(`4bf67bc`), 2.0r and the release machinery (`2c47fe0`…`bf42980`), npm
seeded and then CI-published. The machinery Phase 2 runs on is repaired and
proven. Start at 2a.