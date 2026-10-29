import { isAbsolute, resolve } from 'node:path';
import { isReaderTool } from '../event.js';
import { shellWriteTargets } from '../guards.js';
import { isInside, projectName, worktreeRoot } from '../paths.js';
import { allow, block, type PolicyModule } from '../policy.js';
import { readToolCall, writesFiles } from './tool-call.js';

/**
 * The workspace-writes-only policy (§21.2, layer 1).
 *
 * It blocks a write outside the workspace and outside the OpenAgentsy
 * worktrees of the same project. The policy is built with the workspace it
 * guards, because the roots are what the decision is made against.
 */

/** The stable id of the policy. */
export const WORKSPACE_WRITES_ONLY_ID = 'oa.workspace-writes-only';

/** What the policy is built with. */
export interface WorkspaceWritesOnlyOptions {
  /** The workspace root: the project the agent works in. */
  workspace: string;
  /** The home directory the worktrees live under; the home of the user by default. */
  home?: string | undefined;
}

/** The reason every refusal of this policy carries. */
const REASON = 'Writes are limited to the workspace and OpenAgentsy worktrees.';

/**
 * The reason a refused path carries.
 *
 * The path is named, because a refusal a person cannot act on is a bad
 * refusal: the path is the thing they have to change.
 */
function pathReason(path: string): string {
  return `${REASON} The path ${path} is outside the workspace and the worktrees.`;
}

/**
 * The reason a write the matcher cannot place carries.
 *
 * The command names no path, so the guard cannot show that the write lands
 * inside the roots. The stance is fail-closed: a write that cannot be placed
 * is a write that is refused.
 */
function blindReason(command: string): string {
  return `${REASON} The command \`${command}\` names no path, so the guard cannot show that the write stays inside.`;
}

/**
 * A path, made absolute against the workspace.
 *
 * A host names a file either way, and a relative path is relative to the
 * project the agent works in.
 */
function absolutePath(root: string, path: string): string {
  return isAbsolute(path) ? path : resolve(root, path);
}

/**
 * The refusal a shell command earns, when it earns one.
 *
 * The command is read through the matcher, so a command inside a quoted
 * span or inside a substitution is read as a command of its own. Every path
 * the command would write has to land inside the roots, and a path the
 * matcher cannot name is a path the guard cannot place.
 */
function shellRefusal(command: string, root: string, roots: readonly string[]): string | undefined {
  for (const write of shellWriteTargets(command, root)) {
    if (write.path === undefined) {
      return blindReason(write.command ?? write.source);
    }
    const path = absolutePath(root, write.path);
    if (!isInside(path, roots)) return pathReason(path);
  }
  return undefined;
}

/**
 * The policy itself.
 *
 * The roots are the workspace and the worktrees of the same project, and a
 * write that lands outside both of them is the one that is blocked.
 */
export function workspaceWritesOnly(options: WorkspaceWritesOnlyOptions): PolicyModule {
  const root = resolve(options.workspace);
  const roots = [root, worktreeRoot(projectName(root), options.home)];
  return {
    id: WORKSPACE_WRITES_ONLY_ID,
    // The version moves when the behaviour does: this policy sees the shell
    // writes now, and a regression is attributed to the version that caused
    // it.
    version: '1.1.0',
    layer: 1,
    description: 'Blocks the writes that land outside the workspace and the worktrees.',
    appliesTo: ['PreToolCall'],
    origin: 'first-party',
    evaluate(ctx) {
      const call = readToolCall(ctx);
      if (call === undefined) return allow();
      if (isReaderTool(call.name)) return allow();
      // The shell writes files too, and the file tool's paths do not name
      // them: the write targets of the command are read here.
      if (call.command !== undefined) {
        const refusal = shellRefusal(call.command, root, roots);
        if (refusal !== undefined) return block(refusal);
      }
      if (!writesFiles(call)) return allow();
      const refused = call.files
        .flatMap((file) => [file.path, file.fromPath])
        .find((path) => path !== undefined && !isInside(absolutePath(root, path), roots));
      if (refused === undefined) return allow();
      return block(pathReason(absolutePath(root, refused)));
    },
  };
}
