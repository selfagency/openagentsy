/**
 * The names the workspace's tools answer to.
 *
 * The names live in core for the same reason the board's do: the vocabulary
 * that resolves a tool name back to its base name and the tools the server
 * offers have to be one list. A host hands a tool name over as
 * `<server>_<tool>`, and the base name is the longest suffix this list
 * knows: `openagentsy-memory_oa_memory_decide` is `oa_memory_decide`.
 *
 * A package that offers tools re-exports its own names from here, so the
 * list is written once and a tool that is added is a tool the vocabulary
 * knows.
 */

/** The names of the task tools, in the order they are shown. */
export const taskToolNames = [
  'oa_task_list',
  'oa_task_show',
  'oa_task_create',
  'oa_task_update',
  'oa_task_next',
  'oa_task_archive',
] as const;

/** The names of the memory tools. */
export const memoryToolNames = ['oa_memory_search', 'oa_memory_list', 'oa_memory_decide'] as const;
