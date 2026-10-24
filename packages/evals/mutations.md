# The mutation catalogue

A guard is only proven by a case that fails without it. This file names the
guards, how to break each one on purpose, and the case that must go red when
it is broken.

The procedure is the same for every row:

1. Apply the break.
2. Run the named case:
   `OPENAGENTSY_EVAL=1 bunx --bun vitest run packages/evals --testNamePattern '<case>'`
3. The case must fail. A case that still passes has proved nothing, and the
   catalogue is wrong.
4. Undo the break.

The break is a source change, not a configuration flag, so it is caught by
the review that reads the diff.

| Guard | The break | The case that must fail |
|---|---|---|
| The lease write guard (`packages/adapter-opencode/src/write-guard.ts`) | Let `guardWrite` return `undefined` for a path no lease covers, instead of denying it | `builder scope push` |
| The lease write guard, unknown agent | Return `undefined` instead of denying when the session's agent is not known | `builder scope push` |
| The lease write guard, `apply_patch` | Do not read the paths out of `patchText` | `builder scope push` |
| The grant permission map (`roles.yaml`) | Give `openagentsy_board_lease_grant` to the builder | `builder scope push` |
| The lease cap (`packages/core/src/board/leases.ts`) | Let the fourth writer take a lease | `fault injection` |
| The record identity check (`packages/mcp/src/index.ts`) | Accept any `from` | `fault builder killed` |
| The judge (`packages/evals/src/judge.ts`) | Grade the narration instead of the state | `false premise` |
| The harness's identity check (`packages/evals/src/fixture.ts`) | Compare `from` case-sensitively, so the role key and the agent id are two agents | `scope push` |

The judge row is covered by a test that runs both ways every time:
`packages/evals/src/judge-mutation.test.ts` asserts that a correct
conversation passes and a wrong one fails, so the grader cannot silently
grade nothing.

The unit tests carry the same idea. The V2 event loop's error handling is
covered by `packages/adapter-opencode/src/v2.test.ts`, which was checked to
fail without the handling in place.
