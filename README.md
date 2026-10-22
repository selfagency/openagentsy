# OpenAgentsy

A parallel OpenCode agent built on the evidence in [PLAN.md](./PLAN.md).

One long-lived Lead holds the plan. Read-only scouts fan out. At most three
writers work in isolated worktrees, each owning its own files. A reviewer on a
different model, with a clean context, checks every change. Agents coordinate
through a typed board and a task board, not through free-form chat.

## Status

Batch 1 is done. The rest of PLAN.md is not built yet.

| Piece | State |
| --- | --- |
| `roles.yaml`, the 7 role definitions | done |
| `openagentsy build`, generates agents, commands and skills for V1 or V2 | done |
| `openagentsy doctor`, reports what is installed and what is missing | done |
| `openagentsy setup`, writes the OpenCode config for the target version | done |
| Board MCP server: records, leases, budgets, audit | done |
| `packages/models`, provider inventory and the model lock file | Batch 2 |
| `packages/adapter-opencode`, lease guardrails and `oa_spawn` | Batch 2 |
| `packages/evals`, the safety suite | Batch 3 |

## Layout

```text
openagentsy/
├── roles.yaml                    single source of truth for the 7 roles
├── packages/
│   ├── core/                     role schema, permission mapping, glob matching
│   ├── cli/                      openagentsy build | doctor | setup
│   └── mcp/                      the board server
├── templates/.opencode/skills/   starter skills, copied into .opencode/skills
└── .opencode/                    generated agents, commands, skills
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
`.openagentsy/audit.jsonl` with a policy id and version.

## Usage

```bash
pnpm install
pnpm build
pnpm test

node packages/cli/dist/index.js build --target v1   # or v2
node packages/cli/dist/index.js setup
node packages/cli/dist/index.js doctor
```

`build` detects the installed OpenCode version unless you pass `--target`.
`setup --dry-run` prints the config it would write.

## Decisions that differ from PLAN.md

The plan was written against the documentation. Three things changed when the
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

## Conventions

- TypeScript, strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- pnpm workspace, vitest, `node:sqlite`. No native dependencies.
- Roles are functional names. No personas.
- Every non-trivial path leaves one runnable check behind.
