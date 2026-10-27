import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The paths a write may touch.
 *
 * A write is allowed inside the workspace and inside the OpenAgentsy
 * worktrees of the same project, and nowhere else. The comparison is made
 * on the parts of a path, so a path cannot climb out of a root by naming
 * `..`.
 */

/**
 * A path, split into its parts.
 *
 * The parts are what the comparison is made on: `..` is resolved and an
 * empty part is dropped, so `/root/../etc` is `/etc` and `/root/` is
 * `/root`.
 */
export function pathSegments(path: string): string[] {
  const segments: string[] = [];
  for (const segment of path.replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments;
}

/** Whether a path is absolute. */
function isAbsolutePath(path: string): boolean {
  return path.startsWith('/');
}

/**
 * Whether a path sits inside one of the roots.
 *
 * A path outside every root is outside all of them. An absolute path is
 * never inside a relative root, and the other way round, so a relative
 * path cannot be read as one that is in the workspace.
 */
export function isInside(path: string, roots: readonly string[]): boolean {
  const target = pathSegments(path);
  return roots.some((root) => {
    if (isAbsolutePath(path) !== isAbsolutePath(root)) return false;
    const base = pathSegments(root);
    if (base.length > target.length) return false;
    return base.every((segment, index) => target[index] === segment);
  });
}

/**
 * The name of the project a workspace belongs to.
 */
export function projectName(workspace: string): string {
  const segments = pathSegments(workspace);
  return segments[segments.length - 1] ?? '';
}

/**
 * The root the OpenAgentsy worktrees of a project live under.
 *
 * A worktree is kept outside the repository on purpose (a nested
 * repository confuses the search and the tools), so a write inside one is
 * still a write inside the project.
 */
export function worktreeRoot(project: string, home: string = homedir()): string {
  return join(home, '.openagentsy', 'worktrees', project);
}
