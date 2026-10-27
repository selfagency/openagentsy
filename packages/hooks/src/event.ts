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
 * The event, when it is a tool call.
 *
 * The registry hands every handler the same unknown input, so each rule
 * narrows it first. An input that is not a tool call has no rules to run.
 */
export function readPreToolCall(event: unknown): PreToolCallEvent | undefined {
  if (typeof event !== 'object' || event === null) return undefined;
  const candidate = event as Partial<PreToolCallEvent>;
  if (typeof candidate.toolName !== 'string') return undefined;
  return {
    toolName: candidate.toolName,
    args: isArgs(candidate.args) ? candidate.args : {},
    files: fileRefs(candidate.files),
    ...(typeof candidate.command === 'string' ? { command: candidate.command } : {}),
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
