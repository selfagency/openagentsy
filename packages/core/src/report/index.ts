/**
 * The run report (§12).
 *
 * The module holds the facts of the report and the rendering of them, and
 * it holds no store: the ledger, the findings and the board are read by the
 * caller and handed in, so the report can be rendered from a fixture, from
 * the CLI, from the MCP or from a test without a database anywhere near it.
 */
export * from './render.js';
export * from './types.js';
