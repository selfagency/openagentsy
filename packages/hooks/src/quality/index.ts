/**
 * The quality check in the harness.
 *
 * The store holds the findings of the checks, and the rule runs a check
 * after every write. The waivers are the next bean's: the seam is here and
 * it covers nothing for now.
 *
 * The tools are not here: they carry the whole rule set, and the whole
 * rule set carries the TypeScript compiler. The plugin bundles this
 * package, so the tools are reached by their own path,
 * `@openagentsy/hooks/quality/tools`, and the board server imports them
 * from there.
 */
export * from './findings.js';
export * from './rule.js';
