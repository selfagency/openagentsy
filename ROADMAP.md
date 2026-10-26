# Roadmap

The plans live in `plans/`. This is where they actually stand, and what comes
next. The honest version: what is measured, what is built, and what is still
open.

## 0.1.0 — the current release

OpenCode V1, the board, the guard, the safety suite.

| Piece | State |
| --- | --- |
| Seven roles, generated for V1 and V2 from `roles.yaml` | done |
| The board: records, leases, budgets, audit, classification | done |
| The plugin: the lease guard, the effort ladder, the session harvest | done |
| The model selector and the lock file | done |
| The safety suite: ten cases against real sessions | built, the numbers below |
| The CLI: `build`, `setup`, `doctor`, `models` | done |
| The System One client, and the classifier it serves | done, optional on a key |
| Publishable packages, the changelog, the release workflow | done |

### The numbers that matter

- **Zero unleased writes.** The guard refuses a write to a file no lease
  covers, and the refusal is on the record. The safety suite proves it with
  the builder scope push case.
- **A reviewer that catches the seeded bug.** The target is 70 percent of the
  time. The last measured run on the fixed harness is the number the release
  notes carry.
- **A fault ends in a record.** An unreachable board, a rate limited provider
  and a killed builder must each end in a retry, a fallback or a blocker
  record, never in a silent stall.
- **A calibrated verdict.** A case the judge could not decide gets a
  probability from a System One model, so the suite reports a number rather
  than a shrug. The case itself runs without the key.

### What is not in 0.1.0

- The task store and the Beans compatible board. The board carries records,
  not tasks.
- The memory store. The harvest's candidates land on the board as records
  under the `memory` bean, addressed to the Lead; a `ctx_memory` style store
  is 2a.
- The footprint estimator, the ledger and the offload router. These are the
  first of the 2a packages, and they need the new agent to be worth
  building.
- The V2 harness port. See 0.2.0.
- The AFT registration. The scout's guidance is conditional: it prefers the
  AFT tools when they are registered and reads narrowly with the built-in
  tools when they are not.

## 0.2.0 — OpenCode V2

The plan's exit test for the baseline was "the same suite runs on V1 and
V2". It does not yet, and that is deliberate.

OpenCode 2 has its own plugin API: the guard belongs in the permission hook,
because that is where the agent identity and the target paths arrive. The
adapter already has that path, and a conformance probe proves the plugin
registers and the setup runs against the real V2 binary. What is missing is
the harness: the V2 SDK and client have a different shape, so the suite
needs its own runner.

Also in 0.2.0:

- The V1 permission key stays `bash`; V2 uses `shell` and `subagent`. The
  mapping is already in the generator.
- The board's tools are grouped, so a V2 session carries fewer of them.

## 2a and later — the agent as the product

These are the packages that turn the system from a coordination harness into
an agent that does the work. They are built after 0.1.0 is proven, and they
are dogfooded with the new agent rather than against a synthetic one.

- **`tasks`**: the task store, and the Beans compatible board. Built, with
  the `oa_task_*` tools and the prime block (2026-10-26).
- **`memory`**: the memory slice — the archivist's candidates become
  approved, searchable project memory, and only a person approves them.
  Built (2026-10-26).
- **`footprint`**: what a decision actually costs, so the Lead can spend
  tokens where they matter. Built, with the golden test against EcoLogits
  0.11.3 (2026-10-26).
- **`ledger`**: the token and time ledger, per bean and per role. Built,
  with the board's budget check reading the measured usage and the
  adapter's bridge feeding it (2026-10-26).
- **`offload`**: the local backends, for the jobs that do not need a frontier
  model. Built, with the circuit breaker and the fail-closed replica modes
  (2026-10-26).
- **`hooks`**: the package manager rule, the default rules, the pre-commit
  guard. A red team agent is told to `npm install` something and is stopped.
- **`quality`**: the score a change earns, so the reviewer has something
  sharper than a binary approve.
- **`sidebar`**: the thing that shows a human what the agents are doing.
- **`oa conformance`**: the report that says whether an agent is behaving.
- **`oa report --ethical`**: what the run cost, and what it was worth.

## The baseline that was never measured

Phase 0 asked for one number that was never produced: fewer tokens per
resolved task than a plain OpenCode session, with each layer's saving
measured. The harness for it exists (`packages/evals/src/baseline.ts`); the
instrument does not, and the instrument is the footprint estimator, which is
2a.

So the first number 2a produces is this one, and it is the number that
decides whether the whole idea pays for itself.
