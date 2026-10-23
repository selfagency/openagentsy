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
const MARKERS = /^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s*(.+?)\s*$/gm;
const MOVE = /^\*\*\*\s+Move\s+to:\s*(.+?)\s*$/gm;

/**
 * The paths a patch touches, relative to the project root.
 *
 * A path the patch names twice appears once. A patch that names no path at
 * all yields an empty list, and the caller has nothing to check.
 */
export function patchPaths(patchText: string): string[] {
  const paths = new Set<string>();
  for (const match of patchText.matchAll(MARKERS)) {
    const path = match[1];
    if (path) paths.add(path);
  }
  for (const match of patchText.matchAll(MOVE)) {
    const path = match[1];
    if (path) paths.add(path);
  }
  return [...paths];
}
