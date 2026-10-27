import type { FileRef } from '@openagentsy/hooks';

/**
 * The paths an apply_patch call touches.
 *
 * The apply_patch tool does not take a path argument. It takes the whole
 * patch as text, and the paths live in the marker lines:
 *
 *   *** Add File: src/new-file.ts
 *   *** Update File: src/existing.ts
 *   *** Move to: src/renamed.ts
 *   *** Delete File: src/obsolete.ts
 *
 * A guard that only reads `filePath` sees nothing here, so the paths are
 * pulled out of the marker lines instead.
 */

/** The marker lines of a patch, and the path each one names. */
const MARKERS = /^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s*(.+?)\s*$/;
const MOVE = /^\*\*\*\s+Move\s+to:\s*(.+?)\s*$/;

/**
 * The files a patch touches, in the normalised shape.
 *
 * A move is one file with two ends: the file it comes from and the file it
 * goes to. The rules read both ends, because a patch that moves a file onto
 * a protected path has touched the protected path.
 */
export function patchFiles(patchText: string): FileRef[] {
  const files: FileRef[] = [];
  for (const line of patchText.split('\n')) {
    const marker = MARKERS.exec(line);
    if (marker) {
      const path = marker[1];
      if (path !== undefined && path !== '') files.push({ path });
      continue;
    }
    const move = MOVE.exec(line);
    if (!move) continue;
    const path = move[1];
    if (path === undefined || path === '') continue;
    const current = files[files.length - 1];
    const from = current?.path;
    if (current !== undefined && from !== undefined && current.fromPath === undefined) {
      files[files.length - 1] = { path, fromPath: from };
      continue;
    }
    files.push({ path });
  }
  return files;
}

/**
 * The paths a patch touches, relative to the project root.
 *
 * A path the patch names twice appears once. A patch that names no path at
 * all yields an empty list, and the caller has nothing to check.
 */
export function patchPaths(patchText: string): string[] {
  const paths = new Set<string>();
  for (const file of patchFiles(patchText)) {
    if (file.fromPath !== undefined) paths.add(file.fromPath);
    if (file.path !== undefined) paths.add(file.path);
  }
  return [...paths];
}
