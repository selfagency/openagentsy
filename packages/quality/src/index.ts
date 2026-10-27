/**
 * @openagentsy/quality
 *
 * The anti-slop checks: the rule registry, and the static rules that read
 * a stylesheet, a page, its copy and the comments of a source file.
 *
 * It is a library. The hooks package calls it, and nothing here decides
 * on its own what a person decided.
 */
export * from './check.js';
export * from './comments/index.js';
export * from './compiler-free.js';
export * from './copy/index.js';
export * from './css/index.js';
export * from './gate.js';
export * from './html/index.js';
export * from './markup/index.js';
export * from './report.js';
export * from './rule.js';
export * from './rules.js';
export * from './sloplint.js';
