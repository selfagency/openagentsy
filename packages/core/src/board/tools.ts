/**
 * The board tools.
 *
 * The names are the wire names the board server registers, and they live in
 * core so that the vocabulary which resolves a tool name back to its base
 * name and the tools the server offers are one list. A host hands a tool
 * name over as `<server>_<tool>`, and the base name is the longest suffix
 * this list knows: `openagentsy-board_board_record` is `board_record`.
 *
 * The order is the order the server registers the tools in.
 */
export const boardToolNames = [
  'board_record',
  'board_lease_grant',
  'board_lease',
  'board_budget_set',
  'board_budget',
  'board_lease_revoke',
  'board_classify',
] as const;
