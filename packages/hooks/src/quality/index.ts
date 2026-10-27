/**
 * The quality check in the harness.
 *
 * The store holds the findings of the checks, and the rule runs a check
 * after every write. The waivers are the decisions of people about those
 * findings: a waiver a person recorded covers a finding, and a covered
 * finding is not open.
 *
 * The tools are not here: they carry the whole rule set, and the whole
 * rule set carries the TypeScript compiler. The plugin bundles this
 * package, so the tools are reached by their own path,
 * `@openagentsy/hooks/quality/tools`, and the board server imports them
 * from there. The recording of a waiver is reached the same way,
 * `@openagentsy/hooks/quality/waive`, because it asks the whole rule set
 * whether a rule may be waived.
 */
export * from './findings.js';
export * from './rule.js';
export * from './waivers.js';
