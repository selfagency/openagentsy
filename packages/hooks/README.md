# @openagentsy/hooks

The deterministic guardrails: the rule registry, the default rules, the output
checks, the shell environment policy, the redaction wrapper and the approval
gate. It is a library. The adapter (the OpenCode plugin) calls it; OpenCode
never loads it.

## What it guards

- **Git hooks cannot be skipped.** `--no-verify`, `git commit -n` and
  `HUSKY=0` are refused.
- **The package manager is Bun.** `pnpm`, `yarn`, `npx` and `npm install` are
  refused.
- **Writes stay in the workspace** and in the OpenAgentsy worktrees.
- **Policy files are a person's**: `roles.yaml`, the model lock,
  `opencode.json`, the build config, the lockfile, the hooks, the workflows,
  the templates, the lessons and the waivers.
- **Decisions are a person's**: a lesson, a waiver and a memory promotion are
  decided by a person, never by an agent.
- **Secrets do not get written.** A credential in the content is refused.
- **Destructive commands need an approval**: `rm -rf`, a forced push, a hard
  reset and a dropped table. The escape hatch is `/oa approve <callID>`, and
  a grant passes once.

The human-only guarantee rides the permission map (`roles.yaml`), not this
package: the map denies the three decision tools to every agent role, and
this package is the second layer. The output checks flag, they never block.

## The known gap

The entropy guard in the redaction helper is strictly `> 4.0` bits per
character, so a pure-hex value of 32 characters is never flagged. The helper
is core's, and 2f owns the fix; this package does not widen it.
