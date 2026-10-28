import { type FileRef, isReaderTool } from '@openagentsy/hooks/event';
import { patchFiles } from './patch-paths.js';

/**
 * The files a tool call touches, in the normalised shape (§8.2).
 *
 * The shape is the one the YAML hook plugins use: a list of `{ path,
 * fromPath? }`, so a rule reads the same field whichever host called. The
 * normalisation happens here, before a rule sees the call, because a rule
 * that reads a raw argument has to know the host's argument names, and a
 * host changes them more often than a rule changes.
 *
 * A read names a file as well, and that is not a write. So a reader gets no
 * files at all: the package's own rules would have to undo a file list that
 * was synthesised for a read, and a rule that undoes something is a rule
 * that can be wrong.
 *
 * A name the package does not know is treated as a writer when the call
 * carries a file, so the files are read out of the arguments here for every
 * tool that is not a reader.
 */

/** The argument names a write tool names its file with. */
const PATH_ARGS = ['filePath', 'file_path', 'path', 'file'];

/** The argument names a patch carries its text in. */
const PATCH_ARGS = ['patchText', 'patch'];

/**
 * Whether a tool hands a patch over instead of a path.
 */
function isPatchTool(toolName: string): boolean {
  const lower = toolName.toLowerCase();
  return (
    lower === 'patch' ||
    lower === 'apply_patch' ||
    lower.endsWith('_patch') ||
    lower.endsWith('_apply_patch')
  );
}

/**
 * The arguments of a call, when they are a set of named arguments.
 */
function argsOf(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return {};
  return args as Record<string, unknown>;
}

/**
 * The path a call names, when it names one.
 */
function pathOf(args: Record<string, unknown>): string | undefined {
  for (const key of PATH_ARGS) {
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * The patch a call carries, when it carries one.
 */
function patchOf(args: Record<string, unknown>): string | undefined {
  for (const key of PATCH_ARGS) {
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * The files a tool call touches, in the normalised shape.
 *
 * A reader touches nothing, so it gets an empty list. A patch is read out
 * of its marker lines, because one patch can touch several files and the
 * call has not run yet. Every other tool names its file in an argument, and
 * the argument names are the ones the hosts use.
 */
export function changedFiles(toolName: string, args: unknown): FileRef[] {
  if (isReaderTool(toolName)) return [];
  const named = argsOf(args);
  if (isPatchTool(toolName)) {
    const patch = patchOf(named);
    return patch === undefined ? [] : patchFiles(patch);
  }
  const path = pathOf(named);
  return path === undefined ? [] : [{ path }];
}
