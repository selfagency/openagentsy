import { type ProjectRoots, resolveProjectRoots } from '@openagentsy/core';

/**
 * The two roots of a session (§3.9).
 *
 * The **workspace** is the session's own directory: the worktree, when the
 * session runs in one. It holds the project files the session edits:
 * `roles.yaml`, the project config, the changed-files scope and the task
 * files of `.beans/`. They travel with the branch.
 *
 * The **state root** is the directory that owns the shared OpenAgentsy
 * state: the board database, the leases, the records, the audit log, the
 * rungs, the ledger, the model lock, the lessons, the waivers, the approvals
 * and the memories. In a linked worktree it is the MAIN repository root, so
 * a builder in a worktree reads the Lead's board and not a board of its own.
 */
export type Roots = ProjectRoots;

/**
 * The two roots, resolved from the directory the session runs in.
 *
 * The state root is not canonicalised, and that is the point: the lease
 * check matches a path against the state root, so the base has to share the
 * spelling of the paths it is compared with. A resolved symlink makes a path
 * that sits inside the root look like it escaped it, and the leases the Lead
 * granted stop matching. The root keeps the spelling git gave it.
 */
export function resolveRoots(directory: string): Roots {
  return resolveProjectRoots(directory);
}
