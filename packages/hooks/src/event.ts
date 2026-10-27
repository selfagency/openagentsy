/**
 * The event a tool call arrives as.
 *
 * The host hands a tool call over in its own shape: the tool name, the
 * arguments, and the files the call touches are somewhere in the arguments.
 * The rules are written against this shape instead, so a rule reads the
 * same field whichever host called.
 */

/** A file a call touches. */
export interface FileRef {
  /** The path the call writes to, when it names one. */
  path?: string;
  /** The path the call moves from, when it names one. */
  fromPath?: string;
}

/** The event a tool call arrives as. */
export interface PreToolCallEvent {
  /** The base name of the tool: `write`, `bash`, `oa_task_list`. */
  toolName: string;
  /** The arguments the call was made with. */
  args: Record<string, unknown>;
  /** The files the call touches. */
  files: FileRef[];
  /** The command, for a shell call. */
  command?: string;
  /** The call id, for the approval gate. */
  callID?: string;
  /** The role the call is made for. */
  role?: string;
}

/**
 * The argument names a write tool names its file with.
 *
 * The names are the ones the host uses: `filePath` is OpenCode's, `path`
 * and `file` are the ones other tools use.
 */
const PATH_ARGS = ['filePath', 'file_path', 'path', 'file'];

/**
 * The tools that write, by their exact name.
 */
const WRITING_TOOLS = ['write', 'edit', 'multi_edit', 'patch', 'apply_patch'];

/**
 * The verbs that say a tool writes.
 */
const WRITING_VERBS = [
  'write',
  'edit',
  'patch',
  'create',
  'update',
  'remove',
  'delete',
  'rename',
  'move',
];

/**
 * The nouns that say a tool touches a file.
 */
const FILE_NOUNS = ['file', 'files'];

/**
 * Whether a tool writes a file.
 *
 * The name is read on its token boundaries, in either direction: the
 * built-in names (write, edit, multi_edit, patch, apply_patch) and the
 * names a host composes (write_file, create_file) are the same thing.
 */
export function isWritingTool(toolName: string): boolean {
  const lower = toolName.toLowerCase();
  if (WRITING_TOOLS.some((tool) => lower === tool || lower.endsWith(`_${tool}`))) return true;
  const tokens = toolName
    .split(/[^A-Za-z0-9]+|(?=[a-z0-9][A-Z])/)
    .filter((token) => token.length > 0)
    .map((token) => token.toLowerCase());
  if (WRITING_TOOLS.includes(tokens.join('_'))) return true;
  const verb = tokens.some((token) => WRITING_VERBS.includes(token));
  const noun = tokens.some((token) => FILE_NOUNS.includes(token));
  return verb && noun;
}

/**
 * The event, when it is a tool call.
 *
 * The host hands the raw arguments over, and the rules read the normalised
 * fields. So the normalisation happens here: a command that is named in the
 * arguments is the command, and a file that is named in the arguments is
 * the file the call touches. A host that already normalises (the adapter
 * does) is not contradicted: the files it supplies are kept, and the
 * arguments are the fallback.
 */
export function readPreToolCall(event: unknown): PreToolCallEvent | undefined {
  if (typeof event !== 'object' || event === null) return undefined;
  const candidate = event as Partial<PreToolCallEvent>;
  if (typeof candidate.toolName !== 'string') return undefined;
  const args = isArgs(candidate.args) ? candidate.args : {};
  const files = fileRefs(candidate.files);
  const command = readString(candidate.command) ?? readString(args['command']);
  // The file is read out of the arguments for the tools that write. A
  // read names a file as well, and that is not a write.
  const inferred = isWritingTool(candidate.toolName) ? filesFromArgs(args) : [];
  return {
    toolName: candidate.toolName,
    args,
    files: files.length > 0 ? files : inferred,
    ...(command !== undefined ? { command } : {}),
    ...(typeof candidate.callID === 'string' ? { callID: candidate.callID } : {}),
    ...(typeof candidate.role === 'string' ? { role: candidate.role } : {}),
  };
}

/**
 * The arguments, when they are an object.
 *
 * The host hands unknown shapes over, and an array is not a set of named
 * arguments, so an array is not one either.
 */
function isArgs(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A string, when the field is one.
 */
function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The files, when they are files.
 *
 * A path that is not a string is not a path, so it is dropped rather than
 * carried into a rule that would compare it as one.
 */
function fileRefs(value: unknown): FileRef[] {
  if (!Array.isArray(value)) return [];
  const refs: FileRef[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as { path?: unknown; fromPath?: unknown };
    refs.push({
      ...(typeof record.path === 'string' ? { path: record.path } : {}),
      ...(typeof record.fromPath === 'string' ? { fromPath: record.fromPath } : {}),
    });
  }
  return refs;
}

/**
 * The file a call writes to, when the arguments name one.
 *
 * The arguments are the raw shape of the host, so this is where a path
 * that was never normalised is found.
 */
function filesFromArgs(args: Record<string, unknown>): FileRef[] {
  for (const key of PATH_ARGS) {
    const path = readString(args[key]);
    if (path !== undefined) return [{ path }];
  }
  return [];
}
