import { isAbsolute, resolve } from 'node:path';
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
    version: '1.0.0',
    layer: 1,
    description: 'Blocks the writes that land outside the workspace and the worktrees.',
    appliesTo: ['PreToolCall'],
    origin: 'first-party',
    evaluate(ctx) {
      const call = readToolCall(ctx);
      if (call === undefined) return allow();
      if (!writesFiles(call)) return allow();
      const outside = call.files.some((file) =>
        [file.path, file.fromPath]
          .filter((path): path is string => path !== undefined)
          .some((path) => !isInside(absolutePath(root, path), roots)),
      );
      if (!outside) return allow();
      return block('Writes are limited to the workspace and OpenAgentsy worktrees.');
    },
  };
}
