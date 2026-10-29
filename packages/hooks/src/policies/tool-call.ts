import { isReaderTool, isWritingTool } from '../event.js';
import { contentOf } from '../guards.js';
import type { FileChange, PolicyContext } from '../policy.js';

/**
 * The tool call of a context, read out of it.
 *
 * The context carries the name of the tool and its arguments in the shape
 * the host gave them, so the call is read the way the hook rules read it:
 * the command is the one the arguments name, and the files are the ones the
 * context carries or the arguments name.
 */

/** The tool call, as a policy reads it. */
export interface ToolCallFacts {
  /** The name of the tool. */
  name: string;
  /** The arguments the call was made with. */
  args: Record<string, unknown>;
  /** The command, for a shell call. */
  command?: string | undefined;
  /** The files the call touches. */
  files: FileChange[];
}

/** The argument names a write tool names its file with. */
const PATH_ARGS = ['filePath', 'file_path', 'path', 'file'];

/** The arguments, when they are an object. */
function argsOf(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/** The files the arguments name. */
function filesFromArgs(args: Record<string, unknown>): FileChange[] {
  for (const key of PATH_ARGS) {
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) return [{ path: value }];
  }
  return [];
}

/**
 * The tool call of a context.
 *
 * A context without a tool call has none, and a policy that reads one lets
 * the thing through.
 */
export function readToolCall(ctx: PolicyContext): ToolCallFacts | undefined {
  const call = ctx.toolCall;
  if (call === undefined) return undefined;
  const args = argsOf(call.args);
  const command = args['command'];
  const files = ctx.files !== undefined && ctx.files.length > 0 ? ctx.files : filesFromArgs(args);
  return {
    name: call.name,
    args,
    command: typeof command === 'string' ? command : undefined,
    files,
  };
}

/**
 * Whether a call writes a file.
 *
 * A tool that is known to write writes; a tool that is known to read does
 * not, even when it names a file. A name that is neither is treated as a
 * writer when the call names a file, because a policy that let an unknown
 * name through would let every write the host names in an unfamiliar way
 * through.
 */
export function writesFiles(call: ToolCallFacts): boolean {
  if (isReaderTool(call.name)) return false;
  if (isWritingTool(call.name)) return true;
  return call.files.length > 0;
}

/**
 * The content a call would write.
 *
 * The host puts the content in the arguments: a write carries `content`,
 * an edit carries `newString`, and a patch carries the whole patch.
 */
export function contentOfCall(call: ToolCallFacts): string {
  return contentOf({
    toolName: call.name,
    args: call.args,
    files: call.files,
  });
}

/**
 * Whether a call writes content.
 *
 * A reader does not write content, even when the host hands it the text it
 * read: the content of a read is what the file already holds.
 */
export function writesContent(call: ToolCallFacts): boolean {
  if (isReaderTool(call.name)) return false;
  if (isWritingTool(call.name)) return true;
  return contentOfCall(call) !== '';
}
