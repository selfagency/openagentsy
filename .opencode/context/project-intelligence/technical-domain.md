<!-- Context: project-intelligence/technical | Priority: critical | Version: 1.0 | Updated: 2026-10-22 -->

# Technical Domain

**Purpose**: The stack, the patterns and the rules of OpenAgentsy, so a new
agent writes code that matches the codebase instead of inventing a style.
**Last Updated**: 2026-10-22

## Quick Reference

**Update Triggers**: a dependency changes | a new package appears | the
plugin or MCP surface changes | a rule in `AGENTS.md` changes.
**Audience**: agents writing or reviewing code in this repository.

## Primary Stack

| Layer | Technology | Version | Rationale |
| --- | --- | --- | --- |
| Language | TypeScript | 5.9 | strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` |
| Runtime | Bun | 1.2 | `bun:sqlite` for the board and the plugin, one runtime everywhere |
| Package manager | Bun + Turborepo | 1.2 / 2.6 | workspace of six packages, strict isolated linker, turbo orders the tasks |
| Lint and format | Biome | 2.6 | one tool, one config, no `.eslintrc` + `.prettierrc` pair |
| Tests | Vitest | 3.2 | the safety suite drives real OpenCode sessions through it |
| Storage | bun:sqlite + drizzle | Bun 1.2 | the board owns the database; the plugin opens it directly |
| Tool server | @modelcontextprotocol/sdk | 1.x | the board is an MCP server, so V1 and V2 share it |
| Validation | zod | 4 | every MCP tool input and every role file is validated |
| Bundling | tsdown | 0.15 | the plugin loads from a directory with no `node_modules` |

## Code Patterns

### The board tool (the API surface)

There is no HTTP API. A tool is a zod schema, a handler, and a result
helper. The handler returns a result; it never throws at the caller.

```ts
server.registerTool(
  'board_lease',
  {
    description: 'The leases on the board. op=list lists the leases.',
    inputSchema: { bean: z.string().optional().describe('Only leases for this bean') },
  },
  async (input) => {
    try {
      return text({ leases: listLeases(db, input.bean) });
    } catch (error) {
      return failure(error);
    }
  },
);
```

### The agent file (the component)

There is no UI. The one thing that looks like a component is the renderer
that turns a role into an agent file. The mapping between V1 and V2 lives in
exactly one place, so it is never duplicated.

```ts
export function renderAgent(
  role: RoleDefinition,
  roles: RolesFile,
  options: AgentRenderOptions,
): string {
  const permissions = withProtectedPaths(role, roles.protectedPaths);
  const frontmatter =
    options.target === 'v1'
      ? v1Frontmatter(role, toV1Permissions(permissions), options.model)
      : v2Frontmatter(role, toV2Permissions(permissions), options.model, options.modelVariant);
  return `---\n${renderFrontmatter(frontmatter)}\n---\n\n${renderPrompt(role, options.effort ?? {})}`;
}
```

### The board record (the message between agents)

Records are typed, never chat. Kind, actor, bean, action, state, and a
confidence that says whether it was verified or inferred.

```ts
export type RecordKind = 'status' | 'contract' | 'question' | 'blocker' | 'finding';
export type Confidence = 'verified' | 'inferred' | 'guess';
```

## Naming Conventions

| Type | Convention | Example |
| --- | --- | --- |
| Files and directories | kebab-case | `packages/adapter-opencode/src/guard.ts` |
| Tests | the module name, then `.test.ts` | `leases.test.ts` |
| Functions and variables | camelCase | `grantLeases`, `decideFromLeases` |
| Types and interfaces | PascalCase | `RoleDefinition`, `LeaseDecision` |
| Constants | SCREAMING_SNAKE | `AGENT_PREFIX`, `POLICIES` |
| Roles and agents | kebab-case, agents prefixed `oa-` | `lead` is named `agentsy` |
| Policy ids | dot-separated, `oa.` prefixed | `oa.lease.write`, `oa.scope.violation` |
| Audit records | one JSON object per line | `.openagentsy/audit.jsonl` |

## Code Standards

- TypeScript strict, and the strict flags stay on: `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `isolatedModules`.
- Single quotes, semicolons, two spaces, 100 columns. Biome owns all of it.
- No `any` and no non-null assertions. Both are lint errors, not preferences.
- Named exports only, no default exports.
- Functions over classes; a module is a set of pure functions.
- Early returns instead of nesting. No deep indentation.
- A comment says why, not what. The comment above a function says what the
  rule is and why it exists.
- A module does one thing. The board, the roles, the paths and the model
  selection are separate modules for a reason.
- SQL is parameterized with `?` placeholders, never built by concatenation.
- Errors carry a hint: the message says what happened, the hint says what to
  do next.

## Security Requirements

- One writer per file. A write goes through a lease, and the plugin refuses a
  write that no lease covers. The lease is the boundary, not a convention.
- The role that grants a lease is the Lead. Every other role has the grant
  tool denied by name in the permission map, so the tool is not in its
  toolset at all.
- The board cannot verify who is calling it. The MCP protocol carries no
  caller identity, so no rule may depend on one.
- Protected paths are `ask` for every role: `roles.yaml`, the generated
  agents, the policy modules.
- Every permission decision, lease change and budget stop is audited with a
  policy id and a version.
- No secret is ever written into the repository. Secrets come from the
  environment.
- The plugin is bundled self-contained. It loads from a directory with no
  `node_modules`, so a bare import in it fails silently.

## 📂 Codebase References

| What | Where |
| --- | --- |
| The role schema and the permission mapping | `packages/core/src/roles.ts`, `packages/core/src/permissions.ts` |
| The board, its tables and its audit | `packages/core/src/board/` |
| The board tool surface | `packages/mcp/src/index.ts:86` |
| The lease guard | `packages/adapter-opencode/src/guard.ts:100` |
| The agent file renderer | `packages/cli/src/generate/agent.ts:66` |
| The role source of truth | `roles.yaml` |
| The project rules | `AGENTS.md` |
| Lint, format and thresholds | `biome.jsonc`, `.fallowrc.json` |
| The build and the test commands | `package.json` |

## Related Files

- `AGENTS.md` — the rules an agent must follow in this repository.
- `plans/PLAN.md` — why the system is shaped the way it is.
- `README.md` — what exists and what does not.
