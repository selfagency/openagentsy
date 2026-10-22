# OpenAgentsy

A parallel OpenCode agent built on the evidence in [PLAN.md](./PLAN.md).

One long-lived Lead holds the plan. Read-only scouts fan out. At most three
writers work in isolated worktrees, each owning its own files. A reviewer on a
different model, with a clean context, checks every change. Agents coordinate
through a typed board and a task board, not through free-form chat.

## Status

Batches 1 and 2 are done. The safety suite of Batch 3 is not built yet.

| Piece | State |
| --- | --- |
| `roles.yaml`, the 7 role definitions | done |
| `openagentsy build`, generates agents, commands and skills for V1 or V2 | done |
| `openagentsy doctor`, reports what is installed, where it came from, and what is missing | done |
| `openagentsy setup`, writes the OpenCode config and installs the plugin | done |
| Board MCP server: records, leases, budgets, audit | done |
| `packages/models`, provider inventory, the model lock file, the effort ladder | done |
| `packages/adapter-opencode`, lease guardrails, the effort ladder tool | done |
| `packages/evals`, the safety suite | Batch 3 |

## Layout

```text
openagentsy/
├── roles.yaml                    single source of truth for the 7 roles
├── packages/
│   ├── core/                     role schema, permission mapping, glob matching, the board
│   ├── cli/                      openagentsy build | doctor | setup | models
│   ├── models/                   provider inventory, the lock file, the effort ladder
│   ├── mcp/                      the board server
│   └── adapter-opencode/         the OpenCode plugin
├── templates/.opencode/skills/   starter skills, copied into .opencode/skills
└── .opencode/                    generated agents, commands, skills, the plugin
```

`roles.yaml` is edited by a human. Everything else is generated from it. The
generator maps one internal permission vocabulary onto the two OpenCode
versions, so a role is defined once and both versions get the same behaviour.

## The board

The board is an MCP server over stdio. It holds the hand-off between agents
as typed records instead of transcripts, which is where most of the token
saving comes from.

| Tool | What it does |
| --- | --- |
| `board_post` | Post a typed record: what was done, the state, the artifact, what is needed next, how confident you are |
| `board_inbox` | Read the records waiting for one agent and mark them read, in one call. Cursor based, never a history |
| `board_lease_grant` | Record the files one agent owns |
| `board_lease_check` | Decide whether one path may be written |
| `board_lease_list` | List the leases |
| `board_budget_set` | Set a token budget, stopping at 85 percent of it |
| `board_budget_check` | Check a bean against its budget |
| `board_budget_list` | List the budgets |

State lives in `.openagentsy/board.sqlite`. Every decision appends a line to
`.openagentsy/audit.jsonl` with a policy id and version. The leases are also
published to `.openagentsy/leases.json`, because the plugin cannot open the
database, see below.

## Models

`openagentsy models init` picks a model for every role and writes
`openagentsy.models.lock.json`.

Four sources are joined: what the provider actually serves, what the model can
do, how it ranks, and what its terms are. The rules are in the role, so the
selection is reproducible and every rejection is reported with its reason.

```bash
node packages/cli/dist/index.js models init --providers opencode-go,ollama-cloud
```

```
  lead        opencode-go/glm-5.3
               agentic rank 8, supported evidence, quality first
               not opencode-go/gemini-4-argon-contributor: trains on prompts
               not opencode-go/kimi-k3: quota of 110 requests per 5 hours is below the 200 this role needs
```

The lock file also holds the effort ladder of each role: the model and the
effort level to start at, and the rung to climb to. The levels are the ones
the model really offers, read from models.dev, so a role never asks for a
level that does not exist.

## The plugin

`packages/adapter-opencode` is one file that serves both OpenCode versions.
OpenCode 1 reads `{ id, server }`, OpenCode 2 reads `{ id, setup }`, and each
ignores the other key.

It does two things. It refuses a write to a file that no lease covers or that
another agent owns, and writes the decision to the audit log. It applies the
effort level of the rung a role climbed to, and the `oa_effort` tool is the
only way to climb.

## Usage

```bash
pnpm install
pnpm build
pnpm test

node packages/cli/dist/index.js build --target v1   # or v2
node packages/cli/dist/index.js models init --providers opencode-go,ollama-cloud
node packages/cli/dist/index.js setup
node packages/cli/dist/index.js doctor
```

`build` detects the installed OpenCode version unless you pass `--target`.
`setup --dry-run` prints the config it would write. `models init` shows what
it picked and why before it writes the lock file.

## Decisions that differ from PLAN.md

The plan was written against the documentation. Six things changed when the
code met the real binary.

1. **V1 uses `bash`, not `shell`.** The live V1 docs describe `shell`, but
   OpenCode 1.19.3 silently drops a `shell` key in agent frontmatter and only
   honours `bash`. Verified with `opencode agent list`: the shell patterns of
   a generated agent are absent from the resolved permissions until the key is
   `bash`. V2 uses `shell`.

2. **One adapter file, not two packages.** OpenCode reads `{ id, server }` on
   V1 and `{ id, setup }` on V2 from the same file and ignores the other key,
   so the two planned adapters collapse into one dual-export file.

3. **The privacy filter cannot use models.dev.** models.dev exposes limits,
   cost, tool support and modalities. It exposes no retention or training
   field. Retention data for the Go providers lives in the documentation, so
   it becomes a checked-in policy table with source links rather than an API
   pull. BenchLM is reached over REST, not MCP: the MCP tool names in the
   plan are not in any public page.

4. **The effort levels come from the model, not from the role.** The plan
   names the levels, but a model only offers what it offers. `glm-5.3` has
   `low`, `high` and `max`, and no `medium` or `xhigh`. The lock file takes
   the levels from models.dev and the role asks for the closest one.

5. **The plugin cannot read the board database.** The OpenCode plugin runtime
   has no sqlite module, and a plugin that imports one fails to load at all,
   silently. The board therefore publishes the leases to
   `.openagentsy/leases.json` and the plugin reads that.

6. **The plugin has to be a self contained bundle.** A plugin file is loaded
   from the config directory, where bare imports do not resolve. The adapter
   is bundled with tsdown and imports nothing but the node builtins.

## Conventions

- TypeScript, strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- pnpm workspace, vitest, `node:sqlite`. No native dependencies.
- Roles are functional names. No personas.
- Every non-trivial path leaves one runnable check behind.
