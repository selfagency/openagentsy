import { boardToolNames, memoryToolNames, taskToolNames } from '@openagentsy/core';

/**
 * The base name of a tool.
 *
 * A host hands a tool name over as `<server>_<tool>`: the memory server's
 * `oa_memory_decide` arrives as `openagentsy-memory_oa_memory_decide`. The
 * base name is the tool itself, and the rules are written against the base
 * name, so it has to be the same whichever host called.
 *
 * The prefix is not stripped by a pattern. A pattern that strips
 * `^[a-z0-9-]+_` in front of `oa_` leaves every `board_*` name untouched,
 * which is the hole the vocabulary closes: the name is resolved by the
 * longest suffix the registered vocabulary knows.
 */
export function baseToolName(toolName: string, vocabulary: readonly string[]): string {
  const longest = [...vocabulary].sort((a, b) => b.length - a.length);
  const found = longest.find((entry) => toolName === entry || toolName.endsWith(`_${entry}`));
  return found ?? toolName;
}

/**
 * Every tool name the workspace knows.
 *
 * The board, the task store and the memory slice; whatever else a package
 * exports. The list is the vocabulary a tool name is resolved against.
 */
export const toolVocabulary: readonly string[] = [
  ...boardToolNames,
  ...taskToolNames,
  ...memoryToolNames,
];

/**
 * The base name of a tool, against the workspace vocabulary.
 */
export function baseTool(toolName: string): string {
  return baseToolName(toolName, toolVocabulary);
}
