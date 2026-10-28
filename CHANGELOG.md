# Changelog

Every release, from the commits that made it.

## 0.1.1 - 2026-10-28

### Tested

- **tasks**: the shape of the cost is the gate a runner can check (`0ad19bf`)
- **evals, tasks**: the budget and the directory do not depend on the machine (`8116ef3`)
- **evals, tasks**: a budget and a directory that do not depend on the machine (`915e344`)

### Fixed

- **build**: the project references match the imports (`411f7ff`)
- **config**: the board mcp and the disabled servers, in the shape OpenCode 2 reads (`da13522`)
- **cli**: a test does not reach the network, and a test does not commit into the repository of the hook (`e46f721`)
- **core**: the state root keeps the spelling of the paths it is compared against (`90563b7`)
- **cli**: a test does not need a signing agent (`337ef77`)
- **evals**: a session cannot leave the case directory (`7971f6d`)
- **evals**: a report that says the work is not done is not a completion claim (`bedf06e`)
- **evals**: the two faults land on a live OpenCode 2 server (`d491264`)
- **adapter**: the v2 path kills the builder and harvests the session (`fc4bfaa`)
- **evals**: a removed session and an injected fault are the case's own (`b803639`)
- **evals**: a file watcher that cannot attach is not a host fault (`7d26807`)
- **evals**: the turn ends when the server says the session is idle (`1f78304`)
- **hooks**: a throwaway commit in the eval runner is not signed (`46946d5`)
- **evals**: a file watcher on a throwaway directory is not a host fault (`8103c51`)
- **evals**: the harness reads the global config it is given (`8f3b7ee`)
- **hooks**: a suite proof needs a run, a proof has to be about its lesson (`8e653be`)
- **adapter**: a rule that is written again is placed again, and the scope comes from the leases (`ac1d040`)
- **approvals**: the grant is bounded, atomic, and audited where it is spent (`c76bc0f`)
- **hooks**: the review findings on the lessons, the runner and the proof (`b9d7840`)
- **adapter**: the merge places its rules, and the idle path is caught (`534f5e8`)
- **board**: a skipped regeneration check is a failure, not a clean tree (`7b3c56b`)
- **hooks**: the fifth review round on the guardrail core (`1cb52c7`)
- **hooks**: the fourth review round on the guardrail core (`eaed30e`)
- **hooks**: the third review round on the guardrail core (`949ddcd`)
- **board**: the dispatch's missing fields, one no_progress writer, the doctor's target (`316746a`)
- **hooks**: the second review round on the guardrail core (`c7db979`)
- **hooks**: close the review findings on the guardrail core (`ece0449`)
- **evals**: the watch lives until the harness stops it (`d0303c6`)
- **evals**: the fault targets the dispatched child, not the titled one (`5d4ffa4`)
- **evals**: a dispatch label names the agent it dispatched (`b3b665a`)
- **board**: the inbox answers to the name an agent is called by (`2fee8af`)
- **evals**: the builder's evidence confirms a claim that names the bean (`42137d8`)
- **evals**: the harness never addresses the repository it runs in (`b44472a`)
- **evals**: the fault case's confirmation reads the artifact from the claim (`45bf27f`)
- **evals**: the fault case's judge criterion says what the case actually demands (`7a7c5bd`)
- **evals**: the kill watch catches an untitled child before the race (`4528dc8`)
- **evals**: the kill watch keeps cutting the killed session down (`ee6f323`)
- **mcp**: op=list shows the ledger's measured usage beside the deprecated self-report (`5d1fab2`)
- **mcp**: the deprecation sentence reaches the usage card too (`ff84b76`)
- **offload**: never-throws closed, repair boundary, tests pinned, develop synced (`ec13f51`)
- **footprint**: the fit's notes carry the OLS pull and the residuals their model size (`6e5ca36`)
- **ledger**: backfill counts reasoning once; the retry test proves retries (`9665bec`)
- **tasks**: store roots at the discovered .beans.yml directory; review findings (`98bcae6`)
- **footprint**: version matches develop siblings; WUE per EcoLogits 0.11.3 (`5e673d7`)
- **adapter**: export v2Tool and serialize object results (`b55b44b`)
- **deps**: siblings are workspace dependencies (`096d2c9`)

### Kept

- **release**: the publish list is the whole dependency closure (`ee7b3f6`)
- **release**: the manifests carry 0.2.0, and the voxslopuli home (`79ec52b`)
- the lockfile drops the OpenCode 1 SDK (`e93d3c1`)
- **adapter**: the v2 facts, measured (`c22e3ea`)
- **workflows**: add the trailing newlines biome ci requires (`3017321`)
- **release**: the root manifest moves to 0.1.1 with its packages (`bf42980`)
- **release**: 0.1.1, and the npm step runs outside the repository tree (`efa01a6`)

### Changed

- **core**: the tool definitions move out of the plugin (`780dba0`)
- the project speaks OpenCode 2 only (`79672b2`)
- **evals**: the harness speaks OpenCode 2 only (`316f758`)

### Documented

- the first-party ethics, safety and governance documents (`1770bf9`)
- **plan**: revision 3, applied (`cb029d3`)
- **plan**: the project speaks OpenCode 2 only, and the steps that landed (`5dd93ac`)
- the handoff for phase 2d (`bad5c9e`)
- the enumeration and the roadmap carry the Phase 2b packages (`5e4a9e9`)
- **plans**: the 2a errata - measured values, landed notes, superseded PLAN.md items (`3182055`)
- the roadmap's 2a list carries memory and the landed trio (`2f7226f`)
- the workspace enumeration carries the Phase 2a packages (`bc0eafe`)
- the phase 2 handoff for the next agent (`f3fe848`)
- **changelog**: the 0.1.1 entry (`ce8abf6`)
- **packages**: every package carries its README, license and author (`ca0e420`)

### Added

- **cli**: the ethical report (`72fa51e`)
- **sidebar**: the framing checks, the inbox keys, and the method panel (`b2da7d3`)
- **conformance**: what is proven, observed or unverified (`46306f5`)
- **sidebar**: the blocks and their readers (`1c84f72`)
- **sidebar**: the package, its build, and the footprint block (`26a6b72`)
- **cli**: the state files resolve to the main repository root (`13171bd`)
- **adapter**: the guard reads the board of the main repository (`232a28d`)
- **mcp**: the board resolves to the main repository root (`efa7ede`)
- **core**: the shared state resolves to the main repository root (`14bf07e`)
- **adapter**: the shell runs with a tightened environment (`1d6580d`)
- **adapter**: the guard system runs on the v2 path (`9866ccf`)
- **cli**: the audit command, and the notice for the new skills (`23dfa28`)
- **quality**: the ship gate and the sloplint bridge (`78797b9`)
- **skills**: the three quality skills, and the routing that loads them (`6ce713e`)
- **hooks**: a person records a waiver, an agent may only propose one (`138b853`)
- **hooks**: the quality check runs on every write (`d24be7c`)
- **evals**: the harness runs against an OpenCode 2 server (`b54c84d`)
- **quality**: the comment lint (`bfdde20`)
- **mcp**: the task, memory and lesson tools are registered (`fc4f64c`)
- **evals**: a client for the OpenCode 2 API (`92f04b4`)
- **roles**: the worker roles are visible, and the Lead keeps its dispatches attached (`0eb03ad`)
- **quality**: the HTML and copy rules (`0219532`)
- **quality**: the rule registry and the CSS rules (`8aab499`)
- **2c**: the guardrails, the lessons, and the approval hatch (`40e0f08`)
- **cli**: /oa approve, one shot at a time (`497dde5`)
- **hooks**: lessons, the eval runner, the human-only map (`b3b6d89`)
- **adapter**: the guardrails at the hook points (section 8.2) (`11b8318`)
- **mcp**: a delegation needs an owner and a return condition (`cbb0ec1`)
- **board**: the recovery loop's rules and the doctor's diff (`f1b5314`)
- **hooks**: the guardrail core (registry, rules, checks) (`e3a0e19`)
- **ledger**: waste signals, outcomes and scan-reverts (§6.4, §6.5) (`0b31ebf`)
- **board,adapter,mcp**: the budget check reads the ledger (§6.7) (`60ad7c7`)
- **offload**: the local-model router (§9) (`ccacba3`)
- **footprint**: the prefill fit, shipped dark (§5.3) (`aa6fce2`)
- **ledger**: the numbers-only usage ledger (§6) (`5bc469b`)
- **tasks**: Beans-compatible store, tools and prime (§3) (`a312c46`)
- **memory**: the minimal memory slice with a human-only decide (§4) (`77b47df`)
- **core**: fnv1a64 etag + secret redaction helpers (§3.3, §8.4) (`39e1be1`)
- **cli**: doctor prints the config map (§13) (`f7ab908`)
- **footprint**: EcoLogits-method estimator with ranges (`93ee6db`)
- **adapter**: extract defineTool (§2.3) (`cb6c52b`)

### Built

- **eval**: the safety suite runs by hand, not on a schedule (`dead046`)
- **publish**: drop a variable the copy step does not use (`eba45b5`)

### Improved

- **hooks**: the write path does not carry the TypeScript compiler (`c56efc6`)
